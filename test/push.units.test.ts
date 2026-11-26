import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { validateWebPushEnv, webPushVapidConfig } from '@/config/web-push-env.js';
import { pushSubscriptions, sessions, users } from '@/database/schema.js';
import { isAllowedPushEndpoint, isAllowedPushHost, normalizeAuthSecret, normalizeP256dh } from '@/modules/push/push.endpoint.js';
import { buildMessagePushPayload, PushDeliveryError, PushRateLimiter, PushRepository, PushService, pushTopic, type PushSender } from '@/modules/push/index.js';
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

describe('message push payload', () => {
  const KEY_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
  const base = { roomId: 'r1', senderId: 'u2', recipientIds: ['u1'] };
  const cipher = (bytes: number) => `e2e:v2:${KEY_ID}:${randomBytes(bytes).toString('base64')}`;

  it('carries the ciphertext, ids and kind of a text message', () => {
    const content = cipher(200);
    expect(buildMessagePushPayload({ ...base, message: { id: 'm1', type: 'text', content } })).toEqual({ t: 'msg', roomId: 'r1', m: { id: 'm1', s: 'u2', k: 'text', c: content } });
  });

  it('carries the signed encrypted mime type of media but never their encrypted urls', () => {
    const fileMime = cipher(40);
    for (const type of ['image', 'audio', 'file']) {
      const payload = buildMessagePushPayload({ ...base, message: { id: 'm1', type, content: `https://media.example/${type}`, fileMime } });
      expect(payload).toEqual({ t: 'msg', roomId: 'r1', m: { id: 'm1', s: 'u2', k: type, c: fileMime } });
      expect(JSON.stringify(payload)).not.toContain('media.example');
    }
    expect(buildMessagePushPayload({ ...base, message: { id: 'm1', type: 'image', content: cipher(40), fileMime: 'image/png' } })).toEqual({ t: 'msg', roomId: 'r1', m: { id: 'm1', s: 'u2', k: 'image' } });
    expect(buildMessagePushPayload({ ...base, message: { id: 'm1', type: 'image', content: cipher(40) } })).toEqual({ t: 'msg', roomId: 'r1', m: { id: 'm1', s: 'u2', k: 'image' } });
  });

  it('never forwards content that is not an end-to-end encrypted field', () => {
    const payload = buildMessagePushPayload({ ...base, message: { id: 'm1', type: 'text', content: 'texto em claro' } });
    expect(payload).toEqual({ t: 'msg', roomId: 'r1', m: { id: 'm1', s: 'u2', k: 'text' } });
    expect(JSON.stringify(payload)).not.toContain('claro');
  });

  it('drops the ciphertext when it would not fit in a push and keeps the payload under 3 KB', () => {
    const fits = buildMessagePushPayload({ ...base, message: { id: 'm1', type: 'text', content: cipher(2000) } });
    expect(fits.t === 'msg' && fits.m?.c).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(fits))).toBeLessThanOrEqual(3000);
    const tooBig = buildMessagePushPayload({ ...base, message: { id: 'm1', type: 'text', content: cipher(2400) } });
    expect(tooBig).toEqual({ t: 'msg', roomId: 'r1', m: { id: 'm1', s: 'u2', k: 'text' } });
  });

  it('falls back to the room id alone for system messages, unknown kinds and missing data', () => {
    expect(buildMessagePushPayload(base)).toEqual({ t: 'msg', roomId: 'r1' });
    expect(buildMessagePushPayload({ ...base, message: { id: 'm1', type: 'system', content: cipher(10) } })).toEqual({ t: 'msg', roomId: 'r1' });
    expect(buildMessagePushPayload({ ...base, message: { id: 'x'.repeat(4000), type: 'image', content: '' } })).toEqual({ t: 'msg', roomId: 'r1' });
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

  it('still closes the ring with a call-end push after a restart lost the ringing entry, and tells when the ring expires', async () => {
    const sender = vi.fn<PushSender>(() => Promise.resolve());
    const { service } = await build({ sender });
    await service.subscribe('u1', 's-u1', subscription());
    const expiresAt = Date.now() + 30_000;
    service.incomingCall({ userId: 'u1', callId: 'c1', roomId: 'r', kind: 'voice', ringExpiresAtMs: expiresAt });
    await service.idle();
    expect(JSON.parse(sender.mock.calls[0]?.[1] as string)).toMatchObject({ t: 'call', callId: 'c1', e: expiresAt });

    const { service: restarted } = await build({ sender });
    await restarted.subscribe('u1', 's-u1', subscription());
    restarted.callEnded({ userId: 'u1', callId: 'c1', reason: 'cancelled' });
    await restarted.idle();
    expect(JSON.parse(sender.mock.calls.at(-1)?.[1] as string)).toEqual({ t: 'call-end', callId: 'c1', reason: 'cancelled' });
  });

  it('carries the decline token of the call in the incoming push', async () => {
    const sender = vi.fn<PushSender>(() => Promise.resolve());
    const { service } = await build({ sender });
    await service.subscribe('u1', 's-u1', subscription());
    service.incomingCall({ userId: 'u1', callId: 'c1', roomId: 'r', kind: 'video', ringExpiresAtMs: Date.now() + 30_000, declineToken: 'tok' });
    await service.idle();
    expect(JSON.parse(sender.mock.calls[0]?.[1] as string)).toMatchObject({ t: 'call', callId: 'c1', roomId: 'r', kind: 'video', d: 'tok' });
  });

  it('skips expired rings, skips call-end without a ring and keeps subscriptions on transient failures', async () => {
    const sender = vi.fn<PushSender>(() => Promise.reject(new PushDeliveryError(null)));
    const { service, repository } = await build({ sender });
    await service.subscribe('u1', 's-u1', subscription());
    service.incomingCall({ userId: 'u1', callId: 'c1', roomId: 'r', kind: 'voice', ringExpiresAtMs: Date.now() - 1 });
    await service.idle();
    expect(sender).not.toHaveBeenCalled();
    service.callEnded({ userId: 'u1', callId: 'c1', reason: 'missed' });
    await service.idle();
    expect(sender).not.toHaveBeenCalled();
    service.callEnded({ userId: 'u1', callId: 'other', reason: 'missed' });
    await service.idle();
    expect(sender).toHaveBeenCalledTimes(1);
    sender.mockClear();
    service.newMessage({ roomId: 'r', senderId: 'u2', recipientIds: ['u1'] });
    await service.idle();
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await repository.listForUser('u1')).toHaveLength(1);
  });

  it('rings every device of the callee even with a visible client, with high urgency and a ttl bounded by the ring', async () => {
    const now = Date.UTC(2026, 0, 1);
    const sender = vi.fn<PushSender>(() => Promise.resolve());
    const { service, connected } = await build({ sender, now: () => now });
    await service.subscribe('u1', 's-u1', subscription());
    await service.subscribe('u1', 's-u1', { ...subscription(), endpoint: 'https://fcm.googleapis.com/fcm/send/second-device' });
    connected.add('u1');
    service.incomingCall({ userId: 'u1', callId: 'c1', roomId: 'r', kind: 'voice', ringExpiresAtMs: now + 29_500 });
    await service.idle();
    expect(sender).toHaveBeenCalledTimes(2);
    expect(new Set(sender.mock.calls.map((call) => call[0].endpoint)).size).toBe(2);
    expect(sender.mock.calls[0]?.[2]).toEqual({ TTL: 30, urgency: 'high', topic: pushTopic('call', 'c1') });
  });

  it('forgets a subscription the push service reports as gone and keeps the other devices', async () => {
    for (const status of [404, 410]) {
      const gone = 'https://fcm.googleapis.com/fcm/send/gone-device';
      const sender = vi.fn<PushSender>((target) => (target.endpoint === gone ? Promise.reject(new PushDeliveryError(status)) : Promise.resolve()));
      const { service, repository } = await build({ sender });
      const kept = subscription();
      await service.subscribe('u1', 's-u1', kept);
      await service.subscribe('u1', 's-u1', { ...subscription(), endpoint: gone });
      service.newMessage({ roomId: 'r', senderId: 'u2', recipientIds: ['u1'] });
      await service.idle();
      expect(sender).toHaveBeenCalledTimes(2);
      expect((await repository.listForUser('u1')).map((row) => row.endpoint)).toEqual([kept.endpoint]);
    }
  });

  it('pushes messages only to recipients without a visible client and coalesces bursts per room into one trailing push', async () => {
    vi.useFakeTimers();
    try {
      const sender = vi.fn<PushSender>(() => Promise.resolve());
      const { service, connected } = await build({ sender, now: () => Date.now() });
      await service.subscribe('u1', 's-u1', subscription());
      await service.subscribe('u2', 's-u2', subscription());
      connected.add('u2');
      service.newMessage({ roomId: 'r1', senderId: 'u2', recipientIds: ['u1', 'u2', 'u1'] });
      await service.idle();
      expect(sender).toHaveBeenCalledTimes(1);
      service.newMessage({ roomId: 'r1', senderId: 'u2', recipientIds: ['u1'], message: { id: 'm2', type: 'text', content: 'a' } });
      service.newMessage({ roomId: 'r1', senderId: 'u2', recipientIds: ['u1'], message: { id: 'm3', type: 'text', content: 'b' } });
      await service.idle();
      expect(sender).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3_100);
      await service.idle();
      expect(sender).toHaveBeenCalledTimes(2);
      expect(JSON.parse(sender.mock.calls[1]?.[1] as string)).toMatchObject({ t: 'msg', roomId: 'r1', m: { id: 'm3' } });
      expect(sender.mock.calls[1]?.[2]).toEqual({ TTL: 86_400, urgency: 'high', topic: pushTopic('room', 'r1') });
      await vi.advanceTimersByTimeAsync(10_000);
      await service.idle();
      expect(sender).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a coalesced message at the next window opening instead of losing it', async () => {
    vi.useFakeTimers();
    try {
      const sender = vi.fn<PushSender>(() => Promise.resolve());
      const { service } = await build({ sender, now: () => Date.now() });
      await service.subscribe('u1', 's-u1', subscription());
      for (let index = 0; index < 30; index += 1) {
        service.newMessage({ roomId: `room-${index}`, senderId: 'u2', recipientIds: ['u1'] });
      }
      await service.idle();
      expect(sender).toHaveBeenCalledTimes(30);
      service.newMessage({ roomId: 'room-late', senderId: 'u2', recipientIds: ['u1'] });
      await vi.advanceTimersByTimeAsync(30_000);
      await service.idle();
      expect(sender).toHaveBeenCalledTimes(30);
      await vi.advanceTimersByTimeAsync(31_000);
      await service.idle();
      expect(sender).toHaveBeenCalledTimes(31);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts sending right after listing subscriptions and cleans orphans afterwards', async () => {
    const sender = vi.fn<PushSender>(() => Promise.resolve());
    const { service, repository } = await build({ sender });
    await service.subscribe('u1', 's-u1', subscription());
    const order: string[] = [];
    const deleteOrphans = repository.deleteOrphans.bind(repository);
    vi.spyOn(repository, 'deleteOrphans').mockImplementation(async (userId) => {
      order.push('orphans');
      await deleteOrphans(userId);
    });
    sender.mockImplementation(() => {
      order.push('send');
      return Promise.resolve();
    });
    service.newMessage({ roomId: 'r', senderId: 'u2', recipientIds: ['u1'] });
    await service.idle();
    expect(order).toEqual(['send', 'orphans']);
  });

  it('repeats the ringing push every 10 seconds with the remaining ttl until the call ends', async () => {
    vi.useFakeTimers();
    try {
      const sender = vi.fn<PushSender>(() => Promise.resolve());
      const { service } = await build({ sender, now: () => Date.now() });
      await service.subscribe('u1', 's-u1', subscription());
      service.incomingCall({ userId: 'u1', callId: 'c1', roomId: 'r', kind: 'voice', ringExpiresAtMs: Date.now() + 35_000 });
      await service.idle();
      expect(sender).toHaveBeenCalledTimes(1);
      expect(JSON.parse(sender.mock.calls[0]?.[1] as string)).not.toHaveProperty('r');
      await vi.advanceTimersByTimeAsync(10_000);
      await service.idle();
      expect(sender).toHaveBeenCalledTimes(2);
      expect(JSON.parse(sender.mock.calls[1]?.[1] as string)).toMatchObject({ t: 'call', callId: 'c1', r: 1 });
      expect(sender.mock.calls[1]?.[2]).toEqual({ TTL: 25, urgency: 'high', topic: pushTopic('call', 'c1') });
      await vi.advanceTimersByTimeAsync(10_000);
      await service.idle();
      expect(sender).toHaveBeenCalledTimes(3);
      service.callEnded({ userId: 'u1', callId: 'c1', reason: 'cancelled' });
      await service.idle();
      expect(sender).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(60_000);
      await service.idle();
      expect(sender).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops repeating the ringing push once the ring expires and clears timers on shutdown', async () => {
    vi.useFakeTimers();
    try {
      const sender = vi.fn<PushSender>(() => Promise.resolve());
      const { service } = await build({ sender, now: () => Date.now() });
      await service.subscribe('u1', 's-u1', subscription());
      service.incomingCall({ userId: 'u1', callId: 'c1', roomId: 'r', kind: 'voice', ringExpiresAtMs: Date.now() + 25_000 });
      await vi.advanceTimersByTimeAsync(60_000);
      await service.idle();
      expect(sender).toHaveBeenCalledTimes(3);
      const stop = service.startMaintenance();
      service.incomingCall({ userId: 'u1', callId: 'c2', roomId: 'r', kind: 'voice', ringExpiresAtMs: Date.now() + 60_000 });
      await service.idle();
      stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

  it('sends call pushes ahead of queued message pushes', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sender = vi.fn<PushSender>(async (_subscription, payload) => {
      order.push((JSON.parse(payload) as { t: string }).t);
      await gate;
    });
    const { db, service, repository } = await build({ sender });
    const recipients = ['u1', 'u2', 'u3', 'u4'];
    for (const id of ['u3', 'u4']) {
      const nowIso = new Date().toISOString();
      await db.insert(users).values({ id, nickname: id, nicknameNormalized: id, avatar: 0, passwordHash: 'x', recoveryTokenHash: 'x', createdAt: nowIso, lastSeen: nowIso });
      await db.insert(sessions).values({ id: `s-${id}`, userId: id, tokenHash: `t-${id}`, authMethod: 'password', userAgent: 'test', createdAt: nowIso, lastUsedAt: nowIso });
    }
    for (const id of recipients) {
      for (let index = 0; index < 10; index += 1) {
        await repository.save({ id: `sub-${id}-${index}`, userId: id, sessionId: `s-${id}`, ...subscription(), p256dh: 'x', auth: 'y', userAgent: null, nowIso: new Date().toISOString() });
      }
    }
    service.newMessage({ roomId: 'r1', senderId: 'nobody', recipientIds: recipients });
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const id of recipients) {
      service.incomingCall({ userId: id, callId: `c-${id}`, roomId: 'r', kind: 'voice', ringExpiresAtMs: Date.now() + 30_000 });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await service.idle();
    expect(order).toHaveLength(80);
    expect(order.slice(0, 32)).toEqual(Array(32).fill('msg'));
    expect(order.slice(32, 72)).toEqual(Array(40).fill('call'));
    expect(order.slice(72)).toEqual(Array(8).fill('msg'));
  });

  it('derives stable 32 character topics that differ per call and per room', () => {
    expect(pushTopic('call', 'abc')).toHaveLength(32);
    expect(pushTopic('call', 'abc')).toBe(pushTopic('call', 'abc'));
    expect(pushTopic('call', 'abc')).not.toBe(pushTopic('room', 'abc'));
  });
});
