import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { collectEvents, roundTrip, settle, startSocketHarness, TEST_PASSWORD, waitForDisconnect, waitForEvent, type TestClient } from './support/socket-harness.js';
import { fakeField } from './support/room-keys.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

let harness: Harness | null = null;

async function start(options: Parameters<typeof startSocketHarness>[0] = {}): Promise<Harness> {
  harness = await startSocketHarness(options);
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function loginAnotherDevice(h: Harness, nickname: string) {
  const result = await h.userService.login(nickname, TEST_PASSWORD);
  if (!result) {
    throw new Error('login failed');
  }
  return result;
}

async function joinVisibleRooms(client: TestClient): Promise<void> {
  const listed = waitForEvent(client, 'rooms:list');
  client.emit('rooms:get');
  await listed;
}

describe('session revocation over sockets', () => {
  it('disconnects every other device after a password change and keeps the current one connected', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const otherSession = await loginAnotherDevice(h, 'Alice');
    const current = await h.connectAs(alice);
    const sameSessionTab = await h.connectAs(alice);
    const otherDevice = await h.connectAs(otherSession);

    const revoked = Promise.all([waitForEvent(sameSessionTab, 'user:session-revoked'), waitForEvent(otherDevice, 'user:session-revoked')]);
    const disconnected = Promise.all([waitForDisconnect(sameSessionTab), waitForDisconnect(otherDevice)]);
    const changed = waitForEvent<Record<string, unknown>>(current, 'user:password-changed');
    current.emit('user:change-password', {
      currentPassword: TEST_PASSWORD,
      newPassword: 'another-auth-key-0123456789abcdefghijklmnop',
      newAuthSalt: 'ZnJlc2gtc2FsdC0xMjM0NT',
      encryptedPrivateKeyByPassword: 'rewrapped',
    });

    await expect(changed).resolves.toEqual({});
    await revoked;
    await disconnected;
    await settle(50);

    expect(current.connected).toBe(true);
    expect(h.io.sockets.adapter.rooms.get(`user:${alice.user.id}`)).toBeUndefined();
  });

  it('disconnects every socket bound to a session revoked from another device', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const otherSession = await loginAnotherDevice(h, 'Alice');
    const requester = await h.connectAs(alice);
    const targetTabA = await h.connectAs(otherSession);
    const targetTabB = await h.connectAs(otherSession);

    const disconnected = Promise.all([waitForDisconnect(targetTabA), waitForDisconnect(targetTabB)]);
    const listed = waitForEvent(requester, 'user:sessions');
    requester.emit('user:revoke-session', { sessionId: otherSession.sessionId });
    await listed;
    await disconnected;
    await roundTrip(requester);

    expect(requester.connected).toBe(true);
  });

  it('disconnects the other tabs sharing the session when a device revokes its own session', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const otherSession = await loginAnotherDevice(h, 'Alice');
    const requester = await h.connectAs(alice);
    const sameSessionTab = await h.connectAs(alice);
    const untouched = await h.connectAs(otherSession);
    const untouchedRevocations = collectEvents(untouched, 'user:session-revoked');

    const disconnected = waitForDisconnect(sameSessionTab);
    requester.emit('user:revoke-session', { sessionId: alice.sessionId });
    await disconnected;
    await roundTrip(untouched);

    expect(untouchedRevocations).toHaveLength(0);
    expect(requester.connected).toBe(true);
  });

  it('revokes the tabs of the same session on logout, stops room delivery to the logged out socket and marks the user offline', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const room = await h.roomService.createPrivateRoom(bob.user.id, alice.user.id);
    await h.establishRoomKey(room.id);
    await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    const bobClient = await h.connectAs(bob);
    const loggingOut = await h.connectAs(alice);
    const sameSessionTab = await h.connectAs(alice);
    await Promise.all([joinVisibleRooms(bobClient), joinVisibleRooms(loggingOut)]);
    const afterLogout = collectEvents(loggingOut, 'message:new');

    const disconnected = waitForDisconnect(sameSessionTab);
    const wentOffline = waitForEvent<{ userId: string }>(bobClient, 'user:offline', (event) => event.userId === alice.user.id);
    loggingOut.emit('user:logout');
    await disconnected;
    await wentOffline;

    const delivered = waitForEvent(bobClient, 'message:new', (event: { content: string }) => event.content === fakeField('ainda aí?'));
    bobClient.emit('message:send', { roomId: room.id, content: fakeField('ainda aí?'), messageId: randomUUID() });
    await delivered;
    await settle(100);

    expect(afterLogout).toHaveLength(0);
    expect(loggingOut.connected).toBe(true);
  });
});

describe('connection state recovery', () => {
  async function setupRecoverable(h: Harness) {
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    await h.roomService.createPrivateRoom(bob.user.id, alice.user.id);
    await h.establishRoomKey(room.id);
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    await Promise.all([joinVisibleRooms(aliceClient), joinVisibleRooms(bobClient)]);

    const warmUp = waitForEvent(aliceClient, 'message:new', (event: { content: string }) => event.content === fakeField('aquecendo'));
    bobClient.emit('message:send', { roomId: room.id, content: fakeField('aquecendo'), messageId: randomUUID() });
    await warmUp;

    return { alice, bob, room, aliceClient, bobClient };
  }

  async function dropTransport(client: TestClient): Promise<void> {
    const dropped = waitForDisconnect(client);
    client.io.engine.close();
    await dropped;
  }

  async function reconnect(client: TestClient): Promise<void> {
    const connected = new Promise<void>((resolve) => client.once('connect', () => resolve()));
    client.connect();
    await connected;
  }

  it('keeps a recovered socket bound to a session that is still valid', async () => {
    const h = await start({ connectionStateRecovery: true });
    const { room, aliceClient, bobClient } = await setupRecoverable(h);

    await dropTransport(aliceClient);
    await reconnect(aliceClient);

    expect(aliceClient.recovered).toBe(true);
    await roundTrip(aliceClient);
    const delivered = waitForEvent(aliceClient, 'message:new', (event: { content: string }) => event.content === fakeField('de volta'));
    bobClient.emit('message:send', { roomId: room.id, content: fakeField('de volta'), messageId: randomUUID() });
    await delivered;
  });

  it('rejects the recovery of a socket whose session was revoked while it was disconnected', async () => {
    const h = await start({ connectionStateRecovery: true });
    const { alice, room, aliceClient, bobClient } = await setupRecoverable(h);

    await dropTransport(aliceClient);
    await h.userService.revokeSession(alice.user.id, alice.sessionId);
    const missed = waitForEvent(bobClient, 'message:new', (event: { content: string }) => event.content === fakeField('enquanto fora'));
    bobClient.emit('message:send', { roomId: room.id, content: fakeField('enquanto fora'), messageId: randomUUID() });
    await missed;

    const received = collectEvents<{ content: string }>(aliceClient, 'message:new');
    const revoked = waitForEvent(aliceClient, 'user:session-revoked');
    const disconnected = new Promise<void>((resolve) => aliceClient.once('disconnect', () => resolve()));
    aliceClient.connect();
    await revoked;
    await disconnected;
    await settle(50);

    expect(received).toHaveLength(0);
    expect(h.io.sockets.adapter.rooms.get(`user:${alice.user.id}`)).toBeUndefined();
  });
});
