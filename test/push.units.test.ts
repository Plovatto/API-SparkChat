import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { validateWebPushEnv, webPushVapidConfig } from '@/config/web-push-env.js';
import { pushSubscriptions, sessions, users } from '@/database/schema.js';
import { isAllowedPushEndpoint, isAllowedPushHost, normalizeAuthSecret, normalizeP256dh } from '@/modules/push/push.endpoint.js';
import { PushDeliveryError, PushRateLimiter, PushRepository, PushService, pushTopic, type PushSender } from '@/modules/push/index.js';
import { createTestDb } from './support/create-test-db.js';

const PUBLIC_KEY = Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url');
const PRIVATE_KEY = randomBytes(32).toString('base64url');

function subscription() {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(12).toString('base64url')}`,
    keys: { p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

async function build(
  options: { sender?: PushSender | null; publicKey?: string | null; connected?: Set<string>; now?: () => number; isSessionLive?: (session: { createdAt: string; lastUsedAt: string }, now: number) => boolean } = {},
) {
  const db = await createTestDb();
  for (const id of ['u1', 'u2']) {
    const nowIso = new Date().toISOString();
    await db.insert(users).values({ id, nickname: id, nicknameNormalized: id, avatar: 0, passwordHash: 'x', recoveryTokenHash: 'x', createdAt: nowIso, lastSeen: nowIso });
    await db.insert(sessions).values({ id: `s-${id}`, userId: id, tokenHash: `t-${id}`, authMethod: 'password', userAgent: 'test', createdAt: nowIso, lastUsedAt: nowIso });
  }
  const repository = new PushRepository(db);
  const sender = options.sender === undefined ? vi.fn<PushSender>(() => Promise.resolve()) : options.sender;
  const connected = options.connected ?? new Set<string>();
  const service = new PushService({
    publicKey: options.publicKey === undefined ? PUBLIC_KEY : options.publicKey,
    sender,
    repository,
    limiter: new PushRateLimiter(options.now),
    hasVisibleClient: (userId) => connected.has(userId),
    ...(options.isSessionLive ? { isSessionLive: options.isSessionLive } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { db, repository, service, sender, connected };
}

describe('push endpoint allowlist', () => {
  it('accepts only the known push service hosts', () => {
    for (const host of ['fcm.googleapis.com', 'web.push.apple.com', 'api.push.apple.com', 'updates.push.services.mozilla.com', 'db5p.notify.windows.com', 'FCM.googleapis.com']) {
      expect(isAllowedPushHost(host)).toBe(true);
    }
    for (const host of ['push.apple.com', '.push.apple.com', 'push.services.mozilla.com', 'notify.windows.com', 'fcm.googleapis.com.evil.com', 'evilfcm.googleapis.com', 'a..push.apple.com', 'localhost', '127.0.0.1', '[::1]']) {
      expect(isAllowedPushHost(host)).toBe(false);
    }
  });

  it('requires plain https on the default port', () => {
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com:443/fcm/send/abc')).toBe(true);
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com:444/fcm/send/abc')).toBe(false);
    expect(isAllowedPushEndpoint('https://a:b@fcm.googleapis.com/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com./x')).toBe(false);
    expect(isAllowedPushEndpoint(`https://fcm.googleapis.com/${'a'.repeat(1100)}`)).toBe(false);
  });

  it('normalizes subscription keys and checks their sizes', () => {
    const p256dh = Buffer.concat([Buffer.from([4]), randomBytes(64)]);
    expect(normalizeP256dh(`${p256dh.toString('base64url')}=`)).toBe(p256dh.toString('base64url'));
    expect(normalizeP256dh(Buffer.concat([Buffer.from([2]), randomBytes(64)]).toString('base64url'))).toBeNull();
    expect(normalizeP256dh('a+b/')).toBeNull();
    const auth = randomBytes(16);
    expect(normalizeAuthSecret(auth.toString('base64url'))).toBe(auth.toString('base64url'));
    expect(normalizeAuthSecret(randomBytes(15).toString('base64url'))).toBeNull();
  });
});

describe('web push env', () => {
  const complete = { WEB_PUSH_VAPID_PUBLIC_KEY: PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY: PRIVATE_KEY, WEB_PUSH_SUBJECT: 'mailto:ops@example.com' };

  it('keeps the feature off when nothing is set', () => {
    expect(validateWebPushEnv({})).toBeNull();
    expect(webPushVapidConfig({})).toBeNull();
  });

  it('accepts a complete configuration with a mailto or https subject', () => {
    expect(validateWebPushEnv(complete)).toBeNull();
    expect(webPushVapidConfig({ ...complete, WEB_PUSH_SUBJECT: 'https://chat.example.com' })).toEqual({
      publicKey: PUBLIC_KEY,
      privateKey: PRIVATE_KEY,
      subject: 'https://chat.example.com',
    });
  });

  it('rejects partial or malformed configuration', () => {
    expect(validateWebPushEnv({ WEB_PUSH_VAPID_PUBLIC_KEY: PUBLIC_KEY })?.path).toBe('WEB_PUSH_SUBJECT');
    expect(validateWebPushEnv({ ...complete, WEB_PUSH_VAPID_PUBLIC_KEY: PRIVATE_KEY })?.path).toBe('WEB_PUSH_VAPID_PUBLIC_KEY');
    expect(validateWebPushEnv({ ...complete, WEB_PUSH_VAPID_PRIVATE_KEY: PUBLIC_KEY })?.path).toBe('WEB_PUSH_VAPID_PRIVATE_KEY');
    expect(validateWebPushEnv({ ...complete, WEB_PUSH_SUBJECT: 'http://chat.example.com' })?.path).toBe('WEB_PUSH_SUBJECT');
    expect(validateWebPushEnv({ ...complete, WEB_PUSH_SUBJECT: 'ops@example.com' })?.path).toBe('WEB_PUSH_SUBJECT');
    expect(webPushVapidConfig({ ...complete, WEB_PUSH_SUBJECT: 'nope' })).toBeNull();
  });
});

describe('push service', () => {
  it('sends nothing and reports disabled without a public key', async () => {
    const sender = vi.fn<PushSender>(() => Promise.resolve());
    const { service, repository } = await build({ sender, publicKey: null });
    await repository.save({ id: 's1', userId: 'u1', sessionId: 's-u1', ...subscription(), p256dh: 'x', auth: 'y', userAgent: null, nowIso: new Date().toISOString() });
    expect(service.getConfig()).toEqual({ enabled: false, publicKey: null });
    service.incomingCall({ userId: 'u1', callId: 'c', roomId: 'r', kind: 'voice', ringExpiresAtMs: Date.now() + 30_000 });
    service.callEnded({ userId: 'u1', callId: 'c', reason: 'missed' });
    service.newMessage({ roomId: 'r', senderId: 'u2', recipientIds: ['u1'] });
    await service.idle();
    expect(sender).not.toHaveBeenCalled();
  });

  it('keeps call-end after the incoming push for the same call even when the first send is slow', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sender = vi.fn<PushSender>(async (_subscription, payload) => {
      const parsed = JSON.parse(payload) as { t: string };
      if (parsed.t === 'call') {
        await gate;
      }
      order.push(parsed.t);
    });
    const { service } = await build({ sender });
    await service.subscribe('u1', 's-u1', subscription());
    service.incomingCall({ userId: 'u1', callId: 'c1', roomId: 'r', kind: 'voice', ringExpiresAtMs: Date.now() + 30_000 });
    service.callEnded({ userId: 'u1', callId: 'c1', reason: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await service.idle();
    expect(order).toEqual(['call', 'call-end']);
  });

  it('skips expired rings, skips call-end without a ring and keeps subscriptions on transient failures', async () => {
    const sender = vi.fn<PushSender>(() => Promise.reject(new PushDeliveryError(null)));
    const { service, repository } = await build({ sender });
    await service.subscribe('u1', 's-u1', subscription());
    service.incomingCall({ userId: 'u1', callId: 'c1', roomId: 'r', kind: 'voice', ringExpiresAtMs: Date.now() - 1 });
    await service.idle();
    expect(sender).not.toHaveBeenCalled();
    service.callEnded({ userId: 'u1', callId: 'c1', reason: 'missed' });
    service.callEnded({ userId: 'u1', callId: 'other', reason: 'missed' });
    await service.idle();
    expect(sender).not.toHaveBeenCalled();
    service.newMessage({ roomId: 'r', senderId: 'u2', recipientIds: ['u1'] });
    await service.idle();
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await repository.listForUser('u1')).toHaveLength(1);
  });

  it('pushes messages only to recipients without a visible client and throttles per room', async () => {
    let now = Date.UTC(2026, 0, 1);
    const sender = vi.fn<PushSender>(() => Promise.resolve());
    const { service, connected } = await build({ sender, now: () => now });
    await service.subscribe('u1', 's-u1', subscription());
    await service.subscribe('u2', 's-u2', subscription());
    connected.add('u2');
    service.newMessage({ roomId: 'r1', senderId: 'u2', recipientIds: ['u1', 'u2', 'u1'] });
    await service.idle();
    expect(sender).toHaveBeenCalledTimes(1);
    service.newMessage({ roomId: 'r1', senderId: 'u2', recipientIds: ['u1', 'u2'] });
    await service.idle();
    expect(sender).toHaveBeenCalledTimes(1);
    now += 11_000;
    service.newMessage({ roomId: 'r1', senderId: 'u2', recipientIds: ['u1', 'u2'] });
    await service.idle();
    expect(sender).toHaveBeenCalledTimes(2);
    expect(sender.mock.calls[1]?.[2]).toEqual({ TTL: 86_400, urgency: 'high', topic: pushTopic('room', 'r1') });
  });

  it('updates last use at most once an hour', async () => {
    let now = Date.UTC(2026, 0, 1);
    const { service, repository } = await build({ now: () => now });
    await service.subscribe('u1', 's-u1', subscription());
    now += 30 * 60 * 1000;
    service.newMessage({ roomId: 'r', senderId: 'u2', recipientIds: ['u1'] });
    await service.idle();
    expect((await repository.listForUser('u1'))[0]?.lastUsedAt).toBe(new Date(Date.UTC(2026, 0, 1)).toISOString());
    now += 31 * 60 * 1000;
    service.newMessage({ roomId: 'r', senderId: 'u2', recipientIds: ['u1'] });
    await service.idle();
    expect((await repository.listForUser('u1'))[0]?.lastUsedAt).toBe(new Date(now).toISOString());
  });

  it('stops pushing to a device whose session was revoked or expired', async () => {
    const sender = vi.fn<PushSender>(() => Promise.resolve());
    let live = true;
    const { db, service, repository } = await build({ sender, isSessionLive: () => live });
    await service.subscribe('u1', 's-u1', subscription());
    live = false;
    service.newMessage({ roomId: 'r1', senderId: 'u2', recipientIds: ['u1'] });
    await service.idle();
    expect(sender).not.toHaveBeenCalled();
    live = true;
    await db.run(sql`PRAGMA foreign_keys = OFF`);
    await db.delete(sessions).where(eq(sessions.id, 's-u1'));
    service.newMessage({ roomId: 'r2', senderId: 'u2', recipientIds: ['u1'] });
    await service.idle();
    expect(sender).not.toHaveBeenCalled();
    expect(await repository.listForUser('u1')).toHaveLength(0);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
  });

  it('caps concurrent sends across recipients', async () => {
    let active = 0;
    let peak = 0;
    const sender = vi.fn<PushSender>(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    const { service } = await build({ sender });
    for (let index = 0; index < 10; index += 1) {
      await service.subscribe('u1', 's-u1', subscription());
    }
    for (let index = 0; index < 10; index += 1) {
      service.newMessage({ roomId: `room-${index}`, senderId: 'u2', recipientIds: ['u1'] });
    }
    await service.idle();
    expect(sender).toHaveBeenCalledTimes(100);
    expect(peak).toBeLessThanOrEqual(32);
  });

  it('derives stable 32 character topics that differ per call and per room', () => {
    expect(pushTopic('call', 'abc')).toHaveLength(32);
    expect(pushTopic('call', 'abc')).toBe(pushTopic('call', 'abc'));
    expect(pushTopic('call', 'abc')).not.toBe(pushTopic('room', 'abc'));
  });
});
