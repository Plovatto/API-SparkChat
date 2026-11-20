import { createHash, randomUUID } from 'node:crypto';
import { logger } from '../../config/logger.js';
import { AppError } from '../../lib/app-error.js';
import { isAllowedPushEndpoint, normalizeAuthSecret, normalizeP256dh } from './push.endpoint.js';
import type { PushRateLimiter } from './push.rate-limiter.js';
import type { PushRepository } from './push.repository.js';
import {
  ENCRYPTED_FIELD_PREFIX,
  MAX_CONCURRENT_SENDS,
  MAX_PUSH_PAYLOAD_BYTES,
  MAX_QUEUED_SENDS,
  MAX_USER_AGENT_LENGTH,
  PushDeliveryError,
  type PushCallEndReason,
  type PushConfig,
  type PushMessagePreview,
  type PushPayload,
  type PushPreviewKind,
  type PushSender,
  type PushSendOptions,
  type PushSessionTimes,
  type PushSubscriptionInput,
  type PushSubscriptionRecord,
} from './push.types.js';

const CALL_END_TTL_SECONDS = 60 * 60;
const MESSAGE_TTL_SECONDS = 24 * 60 * 60;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 60_000;
const GONE_STATUSES = new Set([404, 410]);

export interface PushServiceOptions {
  publicKey: string | null;
  sender: PushSender | null;
  repository: PushRepository;
  limiter: PushRateLimiter;
  hasVisibleClient: (userId: string) => boolean;
  isSessionLive?: (session: PushSessionTimes, now: number) => boolean;
  now?: () => number;
}

export interface IncomingCallPush {
  userId: string;
  callId: string;
  roomId: string;
  kind: 'voice' | 'video';
  ringExpiresAtMs: number;
}

export interface CallEndedPush {
  userId: string;
  callId: string;
  reason: PushCallEndReason;
}

export interface NewMessagePush {
  roomId: string;
  senderId: string;
  recipientIds: readonly string[];
  message?: { id: string; type: string; content: string };
}

const PREVIEW_KINDS: ReadonlySet<string> = new Set<PushPreviewKind>(['text', 'image', 'audio', 'file']);

function payloadBytes(payload: PushPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

export function buildMessagePushPayload(input: NewMessagePush): PushPayload {
  const base: PushPayload = { t: 'msg', roomId: input.roomId };
  const message = input.message;
  if (!message || !PREVIEW_KINDS.has(message.type)) {
    return base;
  }
  const preview: PushMessagePreview = { id: message.id, s: input.senderId, k: message.type as PushPreviewKind };
  const withContent: PushPayload = { ...base, m: message.type === 'text' && message.content.startsWith(ENCRYPTED_FIELD_PREFIX) ? { ...preview, c: message.content } : preview };
  if (payloadBytes(withContent) <= MAX_PUSH_PAYLOAD_BYTES) {
    return withContent;
  }
  const withoutContent: PushPayload = { ...base, m: preview };
  return payloadBytes(withoutContent) <= MAX_PUSH_PAYLOAD_BYTES ? withoutContent : base;
}

export function pushTopic(scope: 'call' | 'room', id: string): string {
  return createHash('sha256').update(`${scope}:${id}`).digest('base64url').slice(0, 32);
}

function hostOf(endpoint: string): string | null {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return null;
  }
}

export class PushService {
  private readonly publicKey: string | null;
  private readonly sender: PushSender | null;
  private readonly repository: PushRepository;
  private readonly limiter: PushRateLimiter;
  private readonly hasVisibleClient: (userId: string) => boolean;
  private readonly isSessionLive: (session: PushSessionTimes, now: number) => boolean;
  private readonly now: () => number;
  private readonly ringingCalls = new Map<string, number>();
  private readonly waiting: (() => void)[] = [];
  private activeSends = 0;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(options: PushServiceOptions) {
    this.publicKey = options.publicKey;
    this.sender = options.publicKey ? options.sender : null;
    this.repository = options.repository;
    this.limiter = options.limiter;
    this.hasVisibleClient = options.hasVisibleClient;
    this.isSessionLive = options.isSessionLive ?? (() => true);
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.sender !== null;
  }

  getConfig(): PushConfig {
    return this.enabled ? { enabled: true, publicKey: this.publicKey } : { enabled: false, publicKey: null };
  }

  async subscribe(userId: string, sessionId: string, subscription: PushSubscriptionInput, userAgent?: string): Promise<{ endpoint: string }> {
    if (!this.enabled) {
      throw AppError.of('push.disabled');
    }
    const p256dh = normalizeP256dh(subscription.keys.p256dh);
    const auth = normalizeAuthSecret(subscription.keys.auth);
    if (!isAllowedPushEndpoint(subscription.endpoint) || !p256dh || !auth) {
      throw AppError.of('push.invalidSubscription');
    }
    if (!this.limiter.trySubscriptionChange(userId)) {
      throw AppError.of('push.rateLimited');
    }
    await this.repository.save({
      id: randomUUID(),
      userId,
      sessionId,
      endpoint: subscription.endpoint,
      p256dh,
      auth,
      userAgent: userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
      nowIso: new Date(this.now()).toISOString(),
    });
    return { endpoint: subscription.endpoint };
  }

  async unsubscribe(userId: string, endpoint: string): Promise<{ endpoint: string }> {
    if (!this.limiter.trySubscriptionChange(userId)) {
      throw AppError.of('push.rateLimited');
    }
    await this.repository.deleteOwned(userId, endpoint);
    return { endpoint };
  }

  incomingCall(input: IncomingCallPush): void {
    const ttl = Math.ceil((input.ringExpiresAtMs - this.now()) / 1000);
    if (!this.enabled || ttl <= 0 || !this.limiter.tryCall(input.userId)) {
      return;
    }
    this.ringingCalls.set(`${input.userId}:${input.callId}`, input.ringExpiresAtMs + CALL_END_TTL_SECONDS * 1000);
    const topic = pushTopic('call', input.callId);
    this.enqueue(topic, () =>
      this.deliver(input.userId, { t: 'call', callId: input.callId, roomId: input.roomId, kind: input.kind }, { TTL: ttl, urgency: 'high', topic }),
    );
  }

  callEnded(input: CallEndedPush): void {
    if (!this.enabled || !this.ringingCalls.delete(`${input.userId}:${input.callId}`)) {
      return;
    }
    const topic = pushTopic('call', input.callId);
    this.enqueue(topic, () =>
      this.deliver(input.userId, { t: 'call-end', callId: input.callId, reason: input.reason }, { TTL: CALL_END_TTL_SECONDS, urgency: 'high', topic }),
    );
  }

  newMessage(input: NewMessagePush): void {
    if (!this.enabled) {
      return;
    }
    const topic = pushTopic('room', input.roomId);
    const payload = buildMessagePushPayload(input);
    for (const userId of new Set(input.recipientIds)) {
      if (userId === input.senderId || this.hasVisibleClient(userId) || !this.limiter.tryMessage(userId, input.roomId)) {
        continue;
      }
      this.enqueue(`${userId}:${topic}`, () =>
        this.deliver(userId, payload, { TTL: MESSAGE_TTL_SECONDS, urgency: 'high', topic }),
      );
    }
  }

  startMaintenance(): () => void {
    const timer = setInterval(() => {
      this.limiter.purge();
      this.purgeRingingCalls();
    }, PURGE_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  async idle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  private purgeRingingCalls(): void {
    const current = this.now();
    for (const [key, expiresAt] of this.ringingCalls) {
      if (expiresAt <= current) {
        this.ringingCalls.delete(key);
      }
    }
  }

  private async acquireSendSlot(): Promise<boolean> {
    if (this.activeSends < MAX_CONCURRENT_SENDS) {
      this.activeSends += 1;
      return true;
    }
    if (this.waiting.length >= MAX_QUEUED_SENDS) {
      return false;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    return true;
  }

  private releaseSendSlot(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.activeSends -= 1;
  }

  private enqueue(key: string, work: () => Promise<void>): void {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(work).catch((err: unknown) => {
      logger.error({ err }, 'Push delivery failed');
    });
    this.chains.set(key, next);
    this.inflight.add(next);
    void next.finally(() => {
      this.inflight.delete(next);
      if (this.chains.get(key) === next) {
        this.chains.delete(key);
      }
    });
  }

  private async deliver(userId: string, payload: PushPayload, options: PushSendOptions): Promise<void> {
    const sender = this.sender;
    if (!sender) {
      return;
    }
    await this.repository.deleteOrphans(userId);
    const current = this.now();
    const subscriptions = (await this.repository.listActiveForUser(userId)).filter((subscription) => this.isSessionLive(subscription.session, current));
    const body = JSON.stringify(payload);
    await Promise.all(subscriptions.map((subscription) => this.sendLimited(sender, subscription, body, options)));
  }

  private async sendLimited(sender: PushSender, subscription: PushSubscriptionRecord, body: string, options: PushSendOptions): Promise<void> {
    if (!(await this.acquireSendSlot())) {
      logger.warn({ host: hostOf(subscription.endpoint) }, 'Push send queue full, notification dropped');
      return;
    }
    try {
      await this.sendOne(sender, subscription, body, options);
    } finally {
      this.releaseSendSlot();
    }
  }

  private async sendOne(sender: PushSender, subscription: PushSubscriptionRecord, body: string, options: PushSendOptions): Promise<void> {
    try {
      await sender({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, body, options);
    } catch (error) {
      const statusCode = error instanceof PushDeliveryError ? error.statusCode : null;
      if (statusCode !== null && GONE_STATUSES.has(statusCode)) {
        await this.repository.deleteById(subscription.id);
        return;
      }
      logger.warn({ statusCode, host: hostOf(subscription.endpoint) }, 'Push service rejected a notification');
      return;
    }
    const current = this.now();
    if (current - Date.parse(subscription.lastUsedAt) >= TOUCH_INTERVAL_MS) {
      await this.repository.touch(subscription.id, new Date(current).toISOString(), new Date(current - TOUCH_INTERVAL_MS).toISOString());
    }
  }
}
