import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PushDeliveryError, PushRateLimiter, pushTopic, type PushSender, type PushSendOptions } from '@/modules/push/index.js';
import { fakeField } from './support/room-keys.js';
import { settle, startSocketHarness, TEST_PUSH_PUBLIC_KEY, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

interface ErrorEvent {
  code: string;
  event?: string;
}

interface SentPush {
  endpoint: string;
  payload: Record<string, unknown>;
  raw: string;
  options: PushSendOptions;
}

let harness: Harness | null = null;
const clock = { now: Date.UTC(2026, 5, 15, 12, 0, 0) };

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function fakeSender() {
  const sent: SentPush[] = [];
  const failures = new Map<string, number | null>();
  const sender = vi.fn<PushSender>((subscription, payload, options) => {
    sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) as Record<string, unknown>, raw: payload, options });
    if (failures.has(subscription.endpoint)) {
      return Promise.reject(new PushDeliveryError(failures.get(subscription.endpoint) ?? null));
    }
    return Promise.resolve();
  });
  return { sender, sent, failures };
}

function subscription(host = 'fcm.googleapis.com', token = randomBytes(12).toString('base64url')) {
  return {
    endpoint: `https://${host}/fcm/send/${token}`,
    expirationTime: null,
    keys: {
      p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

function newCallId(): string {
  return randomBytes(16).toString('base64url');
}

async function setup(options: { push?: boolean; limiter?: PushRateLimiter } = {}) {
  clock.now = Date.UTC(2026, 5, 15, 12, 0, 0);
  const fake = fakeSender();
  const h = await startSocketHarness({
    calls: { now: () => clock.now },
    ...(options.push === false ? {} : { push: { sender: fake.sender, ...(options.limiter ? { limiter: options.limiter } : {}) } }),
  });
  harness = h;
  const alice = await h.createAccount('Alice');
  const bob = await h.createAccount('Bobby');
  const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
  await h.roomService.makeVisibleForAll(room, new Date().toISOString());
  return { h, alice, bob, room, ...fake };
}

async function subscribe(client: TestClient, sub = subscription()): Promise<typeof sub> {
  const done = waitForEvent<{ endpoint: string }>(client, 'push:subscribed');
  client.emit('push:subscribe', { subscription: sub });
  expect(await done).toEqual({ endpoint: sub.endpoint });
  return sub;
}

function expectError(client: TestClient, event: string): Promise<ErrorEvent> {
  return waitForEvent<ErrorEvent>(client, 'error', (payload) => payload.event === event);
}

async function endpointsOf(h: Harness, userId: string): Promise<string[]> {
  return (await h.pushRepository.listForUser(userId)).map((row) => row.endpoint).sort();
}

async function joinVisibleRooms(client: TestClient): Promise<void> {
  const listed = waitForEvent(client, 'rooms:list');
  client.emit('rooms:get');
  await listed;
}


const RING_EXPIRY_SHAPE: unknown = expect.any(Number);
const DECLINE_TOKEN_SHAPE: unknown = expect.stringMatching(/^[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+$/);
describe('push config', () => {
  it('announces the feature as disabled without VAPID keys and refuses subscriptions', async () => {
    const { h, alice, sender } = await setup({ push: false });
    const client = await h.connect();
    const config = waitForEvent(client, 'push:config');
    await h.resume(client, alice.user.id, alice.sessionToken);
    expect(await config).toEqual({ enabled: false, publicKey: null });

    const refused = expectError(client, 'push:subscribe');
    client.emit('push:subscribe', { subscription: subscription() });
    expect((await refused).code).toBe('push.disabled');
    expect(await endpointsOf(h, alice.user.id)).toEqual([]);
    expect(h.pushService.enabled).toBe(false);
    expect(sender).not.toHaveBeenCalled();
  });

  it('announces the public key after auth and on request', async () => {
    const { h, alice } = await setup();
    const client = await h.connect();
    const config = waitForEvent(client, 'push:config');
    await h.resume(client, alice.user.id, alice.sessionToken);
    expect(await config).toEqual({ enabled: true, publicKey: TEST_PUSH_PUBLIC_KEY });

    const again = waitForEvent(client, 'push:config');
    client.emit('push:config');
    expect(await again).toEqual({ enabled: true, publicKey: TEST_PUSH_PUBLIC_KEY });
  });

  it('requires authentication', async () => {
    const { h } = await setup();
    const anonymous = await h.connect();
    const refused = waitForEvent<ErrorEvent>(anonymous, 'error');
    anonymous.emit('push:subscribe', { subscription: subscription() });
    expect((await refused).code).toBe('auth.unauthenticated');
  });
});

describe('push subscriptions', () => {
  it('stores subscriptions from every allowed push service', async () => {
    const { h, alice } = await setup();
    const client = await h.connectAs(alice, {});
    const hosts = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'wns2-by3p.notify.windows.com', 'web.push.apple.com', 'api.push.apple.com'];
    const subs = [];
    for (const host of hosts) {
      subs.push(await subscribe(client, subscription(host)));
    }
    expect(await endpointsOf(h, alice.user.id)).toEqual(subs.map((sub) => sub.endpoint).sort());
  });

  it('rejects endpoints outside the push service allowlist and malformed keys', async () => {
    const { h, alice } = await setup();
    const client = await h.connectAs(alice);
    const valid = subscription();
    const invalid = [
      { ...valid, endpoint: 'https://evil.example.com/push' },
      { ...valid, endpoint: 'http://fcm.googleapis.com/fcm/send/abc' },
      { ...valid, endpoint: 'https://fcm.googleapis.com:8443/fcm/send/abc' },
      { ...valid, endpoint: 'https://user:pass@fcm.googleapis.com/fcm/send/abc' },
      { ...valid, endpoint: 'https://fcm.googleapis.com.evil.com/fcm/send/abc' },
      { ...valid, endpoint: 'https://push.apple.com/x' },
      { ...valid, endpoint: 'https://evilpush.apple.com/x' },
      { ...valid, endpoint: 'https://127.0.0.1/x' },
      { ...valid, endpoint: 'https://169.254.169.254/latest' },
      { ...valid, endpoint: 'not a url' },
      { ...valid, keys: { ...valid.keys, p256dh: randomBytes(65).toString('base64url') } },
      { ...valid, keys: { ...valid.keys, p256dh: Buffer.concat([Buffer.from([4]), randomBytes(10)]).toString('base64url') } },
      { ...valid, keys: { ...valid.keys, auth: randomBytes(8).toString('base64url') } },
      { ...valid, keys: { ...valid.keys, auth: '!!!!' } },
    ];
    for (const sub of invalid) {
      const refused = expectError(client, 'push:subscribe');
      client.emit('push:subscribe', { subscription: sub });
      expect((await refused).code).toBe('push.invalidSubscription');
    }

    const malformed = expectError(client, 'push:subscribe');
    client.emit('push:subscribe', { subscription: { endpoint: valid.endpoint } });
    expect((await malformed).code).toBe('validation.invalidPayload');

    const tooLong = expectError(client, 'push:subscribe');
    client.emit('push:subscribe', { subscription: { ...valid, endpoint: `https://fcm.googleapis.com/${'a'.repeat(1100)}` } });
    expect((await tooLong).code).toBe('validation.invalidPayload');

    expect(await endpointsOf(h, alice.user.id)).toEqual([]);
  });

  it('keeps at most ten subscriptions per user and drops the least recently used', async () => {
    const limiter = new PushRateLimiter(() => clock.now);
    const { h, alice } = await setup({ limiter });
    const client = await h.connectAs(alice);
    const subs = [];
    for (let index = 0; index < 11; index += 1) {
      clock.now += 61_000;
      subs.push(await subscribe(client));
    }
    const stored = await endpointsOf(h, alice.user.id);
    expect(stored).toHaveLength(10);
    expect(stored).not.toContain(subs[0]?.endpoint);
    expect(stored).toContain(subs[10]?.endpoint);

    clock.now += 61_000;
    await subscribe(client, subs[1]);
    expect(await endpointsOf(h, alice.user.id)).toHaveLength(10);
  });

  it('updates keys when the same endpoint subscribes again', async () => {
    const { h, alice } = await setup();
    const client = await h.connectAs(alice);
    const sub = await subscribe(client);
    const renewed = { ...sub, keys: subscription().keys };
    await subscribe(client, renewed);
    const rows = await h.pushRepository.listForUser(alice.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.p256dh).toBe(renewed.keys.p256dh);
    expect(rows[0]?.auth).toBe(renewed.keys.auth);
  });

  it('only removes the caller own subscription on unsubscribe', async () => {
    const { h, alice, bob } = await setup();
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const aliceSub = await subscribe(aliceClient);
    const bobSub = await subscribe(bobClient);

    const done = waitForEvent(bobClient, 'push:unsubscribed');
    bobClient.emit('push:unsubscribe', { endpoint: aliceSub.endpoint });
    expect(await done).toEqual({ endpoint: aliceSub.endpoint });
    expect(await endpointsOf(h, alice.user.id)).toEqual([aliceSub.endpoint]);

    const own = waitForEvent(bobClient, 'push:unsubscribed');
    bobClient.emit('push:unsubscribe', { endpoint: bobSub.endpoint });
    await own;
    expect(await endpointsOf(h, bob.user.id)).toEqual([]);
  });

  it('moves an endpoint to the account that registers it on the same browser', async () => {
    const { h, alice, bob } = await setup();
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const sub = await subscribe(aliceClient);
    await subscribe(bobClient, sub);
    expect(await endpointsOf(h, alice.user.id)).toEqual([]);
    expect(await endpointsOf(h, bob.user.id)).toEqual([sub.endpoint]);
  });

  it('rate limits subscription changes per user', async () => {
    const limiter = new PushRateLimiter(() => clock.now);
    const { h, alice } = await setup({ limiter });
    const client = await h.connectAs(alice);
    for (let index = 0; index < 10; index += 1) {
      await subscribe(client);
    }
    const refused = expectError(client, 'push:subscribe');
    client.emit('push:subscribe', { subscription: subscription() });
    expect((await refused).code).toBe('push.rateLimited');

    clock.now += 61_000;
    await subscribe(client);
  });

  it('removes subscriptions with the account', async () => {
    const { h, alice } = await setup();
    const client = await h.connectAs(alice);
    await subscribe(client);
    await h.db.run(`DELETE FROM users WHERE id = '${alice.user.id}'`);
    expect(await endpointsOf(h, alice.user.id)).toEqual([]);
  });
});

describe('call pushes', () => {
  async function callSetup() {
    const context = await setup();
    const aliceClient = await context.h.connectAs(context.alice);
    const bobClient = await context.h.connectAs(context.bob);
    const bobSub = await subscribe(bobClient);
    const aliceSub = await subscribe(aliceClient);
    return { ...context, aliceClient, bobClient, bobSub, aliceSub };
  }

  async function ring(caller: TestClient, callee: TestClient, roomId: string, kind: 'voice' | 'video' = 'video'): Promise<string> {
    const callId = newCallId();
    const incoming = waitForEvent(callee, 'call:incoming');
    caller.emit('call:start', { callId, roomId, kind, envelope: 'opaque-envelope' });
    await incoming;
    return callId;
  }

  it('sends a high urgency content-free push to the callee for an incoming call', async () => {
    const { h, room, aliceClient, bobClient, bobSub, sent } = await callSetup();
    const callId = await ring(aliceClient, bobClient, room.id);
    await h.pushService.idle();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.endpoint).toBe(bobSub.endpoint);
    expect(sent[0]?.payload).toEqual({ t: 'call', callId, roomId: room.id, kind: 'video', e: RING_EXPIRY_SHAPE, d: DECLINE_TOKEN_SHAPE });
    expect(sent[0]?.options).toEqual({ TTL: 45, urgency: 'high', topic: pushTopic('call', callId) });
    expect(sent[0]?.options.topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(sent[0]?.raw).not.toMatch(/Alice|Bobby|opaque-envelope/);
  });

  it('collapses a missed call with the same topic', async () => {
    const { h, room, aliceClient, bobClient, sent } = await callSetup();
    const callId = await ring(aliceClient, bobClient, room.id);
    clock.now += 46_000;
    const ended = waitForEvent(bobClient, 'call:ended');
    await h.callService.runMaintenance();
    await ended;
    await h.pushService.idle();

    expect(sent.map((push) => push.payload)).toEqual([
      { t: 'call', callId, roomId: room.id, kind: 'video', e: RING_EXPIRY_SHAPE, d: DECLINE_TOKEN_SHAPE },
      { t: 'call-end', callId, reason: 'missed' },
    ]);
    expect(sent[1]?.options.topic).toBe(sent[0]?.options.topic);
    expect(sent[1]?.options.urgency).toBe('high');
  });

  it('closes the ring on other devices when the call is cancelled or answered', async () => {
    const { h, room, aliceClient, bobClient, sent } = await callSetup();
    const cancelledId = await ring(aliceClient, bobClient, room.id);
    const cancelled = waitForEvent(bobClient, 'call:ended');
    aliceClient.emit('call:hangup', { callId: cancelledId });
    await cancelled;
    await h.pushService.idle();
    expect(sent.at(-1)?.payload).toEqual({ t: 'call-end', callId: cancelledId, reason: 'cancelled' });

    const answeredId = await ring(aliceClient, bobClient, room.id);
    const accepted = waitForEvent(aliceClient, 'call:accepted');
    bobClient.emit('call:accept', { callId: answeredId, envelope: 'accept-envelope' });
    await accepted;
    await h.pushService.idle();
    expect(sent.at(-1)?.payload).toEqual({ t: 'call-end', callId: answeredId, reason: 'answered' });
    expect(sent.at(-1)?.options.topic).toBe(pushTopic('call', answeredId));

    const count = sent.length;
    const hungUp = waitForEvent(bobClient, 'call:ended');
    aliceClient.emit('call:hangup', { callId: answeredId });
    await hungUp;
    await h.pushService.idle();
    expect(sent).toHaveLength(count);
  });

  it('never pushes call events to the caller', async () => {
    const { h, room, aliceClient, bobClient, aliceSub, sent } = await callSetup();
    const callId = await ring(aliceClient, bobClient, room.id);
    const declined = waitForEvent(aliceClient, 'call:ended');
    bobClient.emit('call:decline', { callId });
    await declined;
    await h.pushService.idle();
    expect(sent.some((push) => push.endpoint === aliceSub.endpoint)).toBe(false);
    expect(sent.at(-1)?.payload).toEqual({ t: 'call-end', callId, reason: 'declined' });
  });

  it('drops subscriptions the push service reports as gone and keeps the rest', async () => {
    const { h, bob, room, aliceClient, bobClient, failures } = await callSetup();
    const gone404 = await subscribe(bobClient);
    const gone410 = await subscribe(bobClient);
    const throttled = await subscribe(bobClient);
    failures.set(gone404.endpoint, 404);
    failures.set(gone410.endpoint, 410);
    failures.set(throttled.endpoint, 429);
    await ring(aliceClient, bobClient, room.id);
    await h.pushService.idle();
    const remaining = await endpointsOf(h, bob.user.id);
    expect(remaining).not.toContain(gone404.endpoint);
    expect(remaining).not.toContain(gone410.endpoint);
    expect(remaining).toContain(throttled.endpoint);
    expect(remaining).toHaveLength(2);
  });
});

describe('message pushes', () => {
  async function messageSetup() {
    const context = await setup();
    await context.h.establishRoomKey(context.room.id);
    const bobClient = await context.h.connectAs(context.bob);
    const bobSub = await subscribe(bobClient);
    const aliceClient = await context.h.connectAs(context.alice);
    await joinVisibleRooms(aliceClient);
    return { ...context, aliceClient, bobClient, bobSub };
  }

  async function send(client: TestClient, roomId: string, text: string, tempId: string): Promise<void> {
    const delivered = waitForEvent<{ clientTempId?: string }>(client, 'message:new', (event) => event.clientTempId === tempId);
    client.emit('message:send', { roomId, content: fakeField(text), messageId: randomUUID(), clientTempId: tempId });
    await delivered;
  }

  it('does not push while the recipient has a visible client', async () => {
    const { h, room, aliceClient, sent } = await messageSetup();
    await send(aliceClient, room.id, 'oi', 'm1');
    await settle(50);
    await h.pushService.idle();
    expect(sent).toEqual([]);
  });

  it('pushes only ids and the end-to-end ciphertext to an offline recipient, collapsed per room', async () => {
    const { h, alice, room, aliceClient, bobClient, bobSub, sent } = await messageSetup();
    bobClient.disconnect();
    await settle(50);
    await send(aliceClient, room.id, 'segredo absoluto', 'm1');
    await h.pushService.idle();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.endpoint).toBe(bobSub.endpoint);
    expect(sent[0]?.payload).toMatchObject({ t: 'msg', roomId: room.id, m: { s: alice.user.id, k: 'text', c: fakeField('segredo absoluto') } });
    expect(Object.keys(sent[0]?.payload ?? {}).sort()).toEqual(['m', 'roomId', 't']);
    expect(Buffer.byteLength(sent[0]?.raw ?? '')).toBeLessThanOrEqual(3000);
    expect(sent[0]?.options).toEqual({ TTL: 86_400, urgency: 'high', topic: pushTopic('room', room.id) });
    expect(sent[0]?.raw).not.toMatch(/segredo|Alice/);

    await send(aliceClient, room.id, 'de novo', 'm2');
    await h.pushService.idle();
    expect(sent).toHaveLength(1);
  });

  async function setVisibility(client: TestClient, visible: boolean): Promise<void> {
    await new Promise<void>((resolve) => {
      client.emit('user:visibility', { visible }, () => resolve());
    });
    await settle(20);
  }

  it('pushes to a recipient whose only client is hidden in the background', async () => {
    const { h, room, aliceClient, bobClient, bobSub, sent } = await messageSetup();
    await setVisibility(bobClient, false);
    await send(aliceClient, room.id, 'oi', 'm1');
    await h.pushService.idle();
    expect(sent.map((push) => push.endpoint)).toEqual([bobSub.endpoint]);
    expect(sent[0]?.options.urgency).toBe('high');
  });

  it('does not push while another device of the recipient is visible', async () => {
    const { h, bob, room, aliceClient, bobClient, sent } = await messageSetup();
    const bobDesktop = await h.connectAs(bob);
    await setVisibility(bobClient, false);
    await send(aliceClient, room.id, 'oi', 'm1');
    await h.pushService.idle();
    expect(sent).toEqual([]);

    await setVisibility(bobDesktop, false);
    clock.now += 11_000;
    await send(aliceClient, room.id, 'de novo', 'm2');
    await h.pushService.idle();
    expect(sent).toHaveLength(1);
  });

  it('stops pushing once the hidden client becomes visible again', async () => {
    const { h, room, aliceClient, bobClient, sent } = await messageSetup();
    await setVisibility(bobClient, false);
    await setVisibility(bobClient, true);
    await send(aliceClient, room.id, 'oi', 'm1');
    await h.pushService.idle();
    expect(sent).toEqual([]);
  });

  it('never pushes the sender own devices', async () => {
    const { h, alice, room, aliceClient, bobClient, sent } = await messageSetup();
    const aliceSub = await subscribe(aliceClient);
    bobClient.disconnect();
    await settle(50);
    await send(aliceClient, room.id, 'oi', 'm1');
    await h.pushService.idle();
    expect(sent.some((push) => push.endpoint === aliceSub.endpoint)).toBe(false);
    expect(await endpointsOf(h, alice.user.id)).toEqual([aliceSub.endpoint]);
  });
});
