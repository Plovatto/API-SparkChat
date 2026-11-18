import { afterEach, describe, expect, it } from 'vitest';
import { collectEvents, roundTrip, settle, startSocketHarness, waitForDisconnect, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

interface RoomPayload {
  room: { id: string; roomCode?: string };
}

let harness: Harness | null = null;

async function start(options: Parameters<typeof startSocketHarness>[0] = {}): Promise<Harness> {
  harness = await startSocketHarness(options);
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function joinVisibleRooms(client: TestClient): Promise<void> {
  const listed = waitForEvent(client, 'rooms:list');
  client.emit('rooms:get');
  await listed;
}

async function createGroup(client: TestClient, roomName: string): Promise<{ id: string; roomCode: string }> {
  const created = waitForEvent<RoomPayload>(client, 'room:created');
  client.emit('room:create-group', { roomName });
  const { room } = await created;
  if (!room.roomCode) {
    throw new Error('group without code');
  }
  return { id: room.id, roomCode: room.roomCode };
}

async function joinByCode(client: TestClient, roomCode: string): Promise<void> {
  const joined = waitForEvent(client, 'room:joined');
  client.emit('room:join-by-code', { roomCode });
  await joined;
}

describe('presence privacy', () => {
  it('sends presence and profile changes only to users who share a room', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const stranger = await h.createAccount('Stranger');
    await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);

    const contact = await h.connectAs(bob);
    const outsider = await h.connectAs(stranger);
    const anonymous = await h.connect();
    const outsiderEvents = [
      ...['user:online', 'user:offline', 'user:profile-updated'].map((event) => collectEvents(outsider, event)),
      ...['user:online', 'user:offline', 'user:profile-updated'].map((event) => collectEvents(anonymous, event)),
    ];

    const cameOnline = waitForEvent<{ userId: string }>(contact, 'user:online', (event) => event.userId === alice.user.id);
    const aliceClient = await h.connectAs(alice);
    await cameOnline;

    const statusChanged = waitForEvent<{ userId: string }>(contact, 'user:profile-updated', (event) => event.userId === alice.user.id);
    aliceClient.emit('user:update-status-text', { statusText: 'ocupada' });
    await statusChanged;

    const wentOffline = waitForEvent<{ userId: string }>(contact, 'user:offline', (event) => event.userId === alice.user.id);
    aliceClient.disconnect();
    await wentOffline;
    await settle(100);

    expect(outsiderEvents.every((events) => events.length === 0)).toBe(true);
  });
});

describe('room key publishing', () => {
  it('never lets a participant replace the sealed key stored for someone else', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    await h.roomKeyRepository.publish(room.id, alice.user.id, 'sealed-by-alice-for-alice');

    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const pushedToAlice = collectEvents(aliceClient, 'e2e:room-key');

    bobClient.emit('e2e:publish-room-key', {
      roomId: room.id,
      keys: [
        { userId: alice.user.id, sealedKey: 'forged-by-bob' },
        { userId: bob.user.id, sealedKey: 'sealed-for-bob' },
      ],
    });
    await roundTrip(bobClient);
    await settle(100);

    expect(await h.roomKeyRepository.findForUser(room.id, alice.user.id)).toBe('sealed-by-alice-for-alice');
    expect(await h.roomKeyRepository.findForUser(room.id, bob.user.id)).toBe('sealed-for-bob');
    expect(pushedToAlice).toHaveLength(0);
  });

  it('stores and delivers the first sealed key published for a participant', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);

    const delivered = waitForEvent<{ roomId: string; sealedKey: string }>(bobClient, 'e2e:room-key');
    aliceClient.emit('e2e:publish-room-key', { roomId: room.id, keys: [{ userId: bob.user.id, sealedKey: 'sealed-for-bob' }] });

    await expect(delivered).resolves.toEqual({ roomId: room.id, sealedKey: 'sealed-for-bob' });
    expect(await h.roomKeyRepository.findForUser(room.id, bob.user.id)).toBe('sealed-for-bob');
  });

  it('drops the sealed keys of a user who publishes a different public key', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    await h.userService.publishE2eKeys(alice.user.id, { publicKey: 'first-public-key' });
    await h.roomKeyRepository.publish(room.id, alice.user.id, 'sealed-to-first-key');

    await h.userService.publishE2eKeys(alice.user.id, { publicKey: 'first-public-key' });
    expect(await h.roomKeyRepository.findForUser(room.id, alice.user.id)).toBe('sealed-to-first-key');

    await h.userService.publishE2eKeys(alice.user.id, { publicKey: 'second-public-key' });
    expect(await h.roomKeyRepository.findForUser(room.id, alice.user.id)).toBeNull();
  });

  it('forwards at most one key request per user and room every thirty seconds', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const group = await createGroup(aliceClient, 'Amigos');
    await joinByCode(bobClient, group.roomCode);
    const requests = collectEvents(aliceClient, 'e2e:key-request');

    bobClient.emit('e2e:request-room-key', { roomId: group.id });
    bobClient.emit('e2e:request-room-key', { roomId: group.id });
    bobClient.emit('e2e:request-room-key', { roomId: group.id });
    await roundTrip(bobClient);
    await settle(100);

    expect(requests).toHaveLength(1);
  });
});

describe('group membership enforcement', () => {
  it('bans a removed member, rotates the invite code and shares the new code only with who stays', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const carol = await h.createAccount('Carol');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const carolClient = await h.connectAs(carol);
    const group = await createGroup(aliceClient, 'Amigos');
    await joinByCode(bobClient, group.roomCode);
    await joinByCode(carolClient, group.roomCode);
    const bobUpdates = collectEvents(bobClient, 'group:user-left');

    const notified = waitForEvent<{ userId: string; roomCode?: string }>(carolClient, 'group:user-left');
    const left = waitForEvent(bobClient, 'group:left');
    aliceClient.emit('group:remove-member', { roomId: group.id, userId: bob.user.id });
    const update = await notified;
    await left;

    expect(update.userId).toBe(bob.user.id);
    expect(update.roomCode).toMatch(/^[A-Z0-9]{10}$/);
    expect(update.roomCode).not.toBe(group.roomCode);
    expect(bobUpdates).toHaveLength(0);

    const rejected = waitForEvent<{ code: string }>(bobClient, 'error');
    bobClient.emit('room:join-by-code', { roomCode: update.roomCode });
    await expect(rejected).resolves.toMatchObject({ code: 'room.notFound' });

    const stale = waitForEvent<{ code: string }>(bobClient, 'error');
    bobClient.emit('room:join-by-code', { roomCode: group.roomCode });
    await expect(stale).resolves.toMatchObject({ code: 'room.notFound' });

    const room = await h.roomService.getRoomById(group.id);
    expect(room?.participants).not.toContain(bob.user.id);
  });

  it('lets a member who left voluntarily join again', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const group = await createGroup(aliceClient, 'Amigos');
    await joinByCode(bobClient, group.roomCode);

    const left = waitForEvent(bobClient, 'group:left');
    bobClient.emit('group:leave', { roomId: group.id });
    await left;

    await joinByCode(bobClient, group.roomCode);
    const room = await h.roomService.getRoomById(group.id);
    expect(room?.participants).toContain(bob.user.id);
  });

  it('stops accepting invite codes after ten failed attempts in an hour', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const group = await createGroup(aliceClient, 'Amigos');

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const failed = waitForEvent<{ code: string }>(bobClient, 'error');
      bobClient.emit('room:join-by-code', { roomCode: `WRONG${attempt}CODE` });
      await expect(failed).resolves.toMatchObject({ code: 'room.notFound' });
    }

    const limited = waitForEvent<{ code: string }>(bobClient, 'error');
    bobClient.emit('room:join-by-code', { roomCode: group.roomCode });
    await expect(limited).resolves.toMatchObject({ code: 'rateLimit.roomJoin' });
  });

  it('ignores block requests inside groups', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const group = await createGroup(aliceClient, 'Amigos');
    await joinByCode(bobClient, group.roomCode);
    const blocked = collectEvents(bobClient, 'user:blocked');

    aliceClient.emit('user:block', { roomId: group.id, blockedUserId: bob.user.id });
    await roundTrip(aliceClient);
    await settle(100);

    const room = await h.roomService.getRoomById(group.id);
    expect(room?.blockedBy).toEqual({});
    expect(blocked).toHaveLength(0);
  });

  it('clears blocks involving a member who leaves or is removed', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const carol = await h.createAccount('Carol');
    const group = await h.roomService.createGroupRoom('Amigos', alice.user.id);
    if (!group.roomCode) {
      throw new Error('group without code');
    }
    await h.roomService.joinByCode(group.roomCode, bob.user.id);
    await h.roomService.joinByCode(group.roomCode, carol.user.id);
    await h.roomRepository.update(group.id, { blockedBy: { [alice.user.id]: bob.user.id, [carol.user.id]: alice.user.id } });

    const afterLeave = await h.roomService.leaveGroup(group.id, bob.user.id);
    expect(afterLeave?.blockedBy).toEqual({ [carol.user.id]: alice.user.id });

    const afterRemoval = await h.roomService.removeMember(group.id, alice.user.id, carol.user.id);
    expect(afterRemoval?.blockedBy).toEqual({});
  });
});

describe('connection state recovery and membership', () => {
  async function dropTransport(client: TestClient): Promise<void> {
    const dropped = waitForDisconnect(client);
    client.io.engine.close();
    await dropped;
  }

  it('does not restore a removed member into the room or replay what was said after the removal', async () => {
    const h = await start({ connectionStateRecovery: true });
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const group = await createGroup(aliceClient, 'Amigos');
    await joinByCode(bobClient, group.roomCode);
    await Promise.all([joinVisibleRooms(aliceClient), joinVisibleRooms(bobClient)]);

    const warmUp = waitForEvent(bobClient, 'message:new', (event: { content: string }) => event.content === 'aquecendo');
    aliceClient.emit('message:send', { roomId: group.id, content: 'aquecendo' });
    await warmUp;

    await dropTransport(bobClient);
    await h.roomService.removeMember(group.id, alice.user.id, bob.user.id);
    const sent = waitForEvent(aliceClient, 'message:new', (event: { content: string }) => event.content === 'depois da remoção');
    aliceClient.emit('message:send', { roomId: group.id, content: 'depois da remoção' });
    await sent;

    const received = collectEvents<{ roomId: string }>(bobClient, 'message:new');
    const reconnected = new Promise<void>((resolve) => bobClient.once('connect', () => resolve()));
    bobClient.connect();
    await reconnected;
    await roundTrip(bobClient);

    expect(bobClient.recovered).toBe(true);
    expect(h.io.sockets.adapter.rooms.get(group.id)?.has(bobClient.id ?? '')).toBeFalsy();
    expect(h.io.sockets.adapter.rooms.get(`user:${bob.user.id}`)?.has(bobClient.id ?? '')).toBe(true);

    const later = waitForEvent(aliceClient, 'message:new', (event: { content: string }) => event.content === 'ainda depois');
    aliceClient.emit('message:send', { roomId: group.id, content: 'ainda depois' });
    await later;
    await settle(100);

    expect(received.filter((message) => message.roomId === group.id)).toHaveLength(0);
  });
});
