import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import { sessions, users } from '@/database/schema.js';
import { PushRateLimiter, PushRepository, PushService, type PushSender } from '@/modules/push/index.js';
import { createTestDb } from './create-test-db.js';

export const PUBLIC_KEY = Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url');
export const PRIVATE_KEY = randomBytes(32).toString('base64url');

export function subscription() {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(12).toString('base64url')}`,
    keys: { p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

export async function build(
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
