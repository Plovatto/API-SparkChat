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

describe('presence and blocks', () => {
  it('stops sending presence between two users once one blocks the other', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    await h.roomService.blockUser(room.id, alice.user.id, bob.user.id);
    const bobClient = await h.connectAs(bob);
    const seen = collectEvents<{ userId: string }>(bobClient, 'user:online');

    await h.connectAs(alice);
    await settle(150);

    expect(seen.filter((event) => event.userId === alice.user.id)).toHaveLength(0);
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

    const rejected = waitForEvent<{ roomId: string }>(bobClient, 'e2e:room-key-rejected');
    bobClient.emit('e2e:publish-room-key', {
      roomId: room.id,
      keys: [
        { userId: alice.user.id, sealedKey: 'forged-by-bob' },
        { userId: bob.user.id, sealedKey: 'sealed-for-bob' },
      ],
    });
    await expect(rejected).resolves.toEqual({ roomId: room.id });
    await settle(100);

    expect(await h.roomKeyRepository.findForUser(room.id, alice.user.id)).toBe('sealed-by-alice-for-alice');
    expect(await h.roomKeyRepository.findForUser(room.id, bob.user.id)).toBeNull();
    expect(pushedToAlice).toHaveLength(0);
  });

  it('refuses to replace a key the publisher already has, so every device keeps the same key', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    await h.roomKeyRepository.publish(room.id, alice.user.id, 'key-from-first-device');
    const laptop = await h.connectAs(alice);
    const phone = await h.connectAs(alice);
    const phonePushes = collectEvents(phone, 'e2e:room-key');

    const rejected = waitForEvent(laptop, 'e2e:room-key-rejected');
    laptop.emit('e2e:publish-room-key', { roomId: room.id, keys: [{ userId: alice.user.id, sealedKey: 'competing-key' }] });
    await rejected;
    await settle(50);

    expect(await h.roomKeyRepository.findForUser(room.id, alice.user.id)).toBe('key-from-first-device');
    expect(phonePushes).toHaveLength(0);
  });

  it('keeps exactly one key when two devices publish their own at the same time', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const group = await h.roomService.createGroupRoom('Amigos', alice.user.id);
    const bob = await h.createAccount('Bob');
    if (!group.roomCode) {
      throw new Error('group without code');
    }
    await h.roomService.joinByCode(group.roomCode, bob.user.id);
    const laptop = await h.connectAs(alice);
    const phone = await h.connectAs(alice);
    const rejections = [...[laptop, phone].map((client) => collectEvents(client, 'e2e:room-key-rejected'))];

    laptop.emit('e2e:publish-room-key', { roomId: group.id, keys: [{ userId: alice.user.id, sealedKey: 'from-laptop' }] });
    phone.emit('e2e:publish-room-key', { roomId: group.id, keys: [{ userId: alice.user.id, sealedKey: 'from-phone' }] });
    await Promise.all([roundTrip(laptop), roundTrip(phone)]);
    await settle(200);

    const stored = await h.roomKeyRepository.findForUser(group.id, alice.user.id);
    expect(['from-laptop', 'from-phone']).toContain(stored);
    expect(rejections.flat()).toHaveLength(1);
  });

  it('lets only one of two users who open a private chat at once establish the key', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const rejections = [collectEvents(aliceClient, 'e2e:room-key-rejected'), collectEvents(bobClient, 'e2e:room-key-rejected')];

    aliceClient.emit('e2e:publish-room-key', {
      roomId: room.id,
      keys: [
        { userId: alice.user.id, sealedKey: 'k1-alice' },
        { userId: bob.user.id, sealedKey: 'k1-bob' },
      ],
    });
    bobClient.emit('e2e:publish-room-key', {
      roomId: room.id,
      keys: [
        { userId: bob.user.id, sealedKey: 'k2-bob' },
        { userId: alice.user.id, sealedKey: 'k2-alice' },
      ],
    });
    await Promise.all([roundTrip(aliceClient), roundTrip(bobClient)]);
    await settle(200);

    const aliceKey = await h.roomKeyRepository.findForUser(room.id, alice.user.id);
    const bobKey = await h.roomKeyRepository.findForUser(room.id, bob.user.id);
    expect([aliceKey?.slice(0, 2), bobKey?.slice(0, 2)]).toSatisfy(([first, second]: string[]) => first === second);
    expect(rejections.flat()).toHaveLength(1);
  });

  it('lets the only member of a group replace their own unreadable key', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const group = await h.roomService.createGroupRoom('Sozinha', alice.user.id);
    await h.roomKeyRepository.publish(group.id, alice.user.id, 'unreadable');
    const aliceClient = await h.connectAs(alice);
    const rejected = collectEvents(aliceClient, 'e2e:room-key-rejected');

    aliceClient.emit('e2e:publish-room-key', { roomId: group.id, keys: [{ userId: alice.user.id, sealedKey: 'fresh' }] });
    await roundTrip(aliceClient);
    await settle(50);

    expect(rejected).toHaveLength(0);
    expect(await h.roomKeyRepository.findForUser(group.id, alice.user.id)).toBe('fresh');
  });

  it('does not let a user’s own pending request unlock replacing their own key', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const group = await createGroup(aliceClient, 'Amigos');
    await joinByCode(bobClient, group.roomCode);
    await h.roomKeyRepository.publish(group.id, alice.user.id, 'existing');

    const forwarded = waitForEvent(bobClient, 'e2e:key-request');
    aliceClient.emit('e2e:request-room-key', { roomId: group.id });
    await forwarded;
    const rejected = waitForEvent(aliceClient, 'e2e:room-key-rejected');
    aliceClient.emit('e2e:publish-room-key', { roomId: group.id, keys: [{ userId: alice.user.id, sealedKey: 'own-replacement' }] });
    await rejected;

    expect(await h.roomKeyRepository.findForUser(group.id, alice.user.id)).toBe('existing');
  });

  it('delivers a first own key to the publisher’s other devices', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const group = await h.roomService.createGroupRoom('Amigos', alice.user.id);
    const laptop = await h.connectAs(alice);
    const phone = await h.connectAs(alice);

    const pushed = waitForEvent<{ sealedKey: string }>(phone, 'e2e:room-key');
    laptop.emit('e2e:publish-room-key', { roomId: group.id, keys: [{ userId: alice.user.id, sealedKey: 'first-key' }] });

    await expect(pushed).resolves.toMatchObject({ sealedKey: 'first-key' });
  });

  it('lets the user re-establish the key of a conversation with the assistant', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const now = new Date().toISOString();
    await h.userRepository.insert({
      id: 'assistant-not-in-tests',
      nickname: 'SparkAI',
      nicknameNormalized: 'sparkai',
      avatar: 0,
      passwordHash: 'x',
      recoveryTokenHash: 'y',
      status: 'online',
      statusText: null,
      createdAt: now,
      lastSeen: now,
    });
    const room = await h.roomService.createPrivateRoom(alice.user.id, 'assistant-not-in-tests');
    await h.roomKeyRepository.publish(room.id, 'assistant-not-in-tests', 'stale-assistant-key');
    await h.roomKeyRepository.publish(room.id, alice.user.id, 'stale-alice-key');
    const aliceClient = await h.connectAs(alice);
    const rejected = collectEvents(aliceClient, 'e2e:room-key-rejected');

    aliceClient.emit('e2e:publish-room-key', {
      roomId: room.id,
      keys: [
        { userId: alice.user.id, sealedKey: 'fresh-for-alice' },
        { userId: 'assistant-not-in-tests', sealedKey: 'fresh-for-assistant' },
      ],
    });
    await roundTrip(aliceClient);
    await settle(100);

    expect(rejected).toHaveLength(0);
    expect(await h.roomKeyRepository.findForUser(room.id, alice.user.id)).toBe('fresh-for-alice');
    expect(await h.roomKeyRepository.findForUser(room.id, 'assistant-not-in-tests')).toBe('fresh-for-assistant');
  });

  it('writes nothing from a batch that would create a competing key', async () => {
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
    await h.roomKeyRepository.publish(group.id, bob.user.id, 'real-key-for-bob');

    const rejected = waitForEvent(aliceClient, 'e2e:room-key-rejected');
    aliceClient.emit('e2e:publish-room-key', {
      roomId: group.id,
      keys: [
        { userId: alice.user.id, sealedKey: 'competing-for-alice' },
        { userId: carol.user.id, sealedKey: 'competing-for-carol' },
        { userId: bob.user.id, sealedKey: 'competing-for-bob' },
      ],
    });
    await rejected;

    expect(await h.roomKeyRepository.findForUser(group.id, alice.user.id)).toBeNull();
    expect(await h.roomKeyRepository.findForUser(group.id, carol.user.id)).toBeNull();
    expect(await h.roomKeyRepository.findForUser(group.id, bob.user.id)).toBe('real-key-for-bob');
  });

  it('replaces a stored key only after its owner asked for it, and only once', async () => {
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
    await h.roomKeyRepository.publish(group.id, alice.user.id, 'unreadable-key');

    bobClient.emit('e2e:publish-room-key', { roomId: group.id, keys: [{ userId: alice.user.id, sealedKey: 'unsolicited' }] });
    await roundTrip(bobClient);
    await settle(50);
    expect(await h.roomKeyRepository.findForUser(group.id, alice.user.id)).toBe('unreadable-key');

    const forwarded = waitForEvent(bobClient, 'e2e:key-request');
    aliceClient.emit('e2e:request-room-key', { roomId: group.id });
    await forwarded;

    const delivered = waitForEvent<{ sealedKey: string }>(aliceClient, 'e2e:room-key');
    bobClient.emit('e2e:publish-room-key', { roomId: group.id, keys: [{ userId: alice.user.id, sealedKey: 'answer-from-bob' }] });
    await expect(delivered).resolves.toMatchObject({ sealedKey: 'answer-from-bob' });

    carolClient.emit('e2e:publish-room-key', { roomId: group.id, keys: [{ userId: alice.user.id, sealedKey: 'late-answer' }] });
    await roundTrip(carolClient);
    await settle(50);
    expect(await h.roomKeyRepository.findForUser(group.id, alice.user.id)).toBe('answer-from-bob');
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

  it('refuses to leave a private conversation as if it were a group, keeping the block', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    await h.roomService.blockUser(room.id, alice.user.id, bob.user.id);
    const bobClient = await h.connectAs(bob);
    const left = collectEvents(bobClient, 'group:left');

    bobClient.emit('group:leave', { roomId: room.id });
    await roundTrip(bobClient);
    await settle(100);

    const after = await h.roomService.getRoomById(room.id);
    expect(after?.participants).toContain(bob.user.id);
    expect(after?.blockedBy).toEqual({ [bob.user.id]: alice.user.id });
    expect(left).toHaveLength(0);
  });

  it('counts parallel invite code attempts before they finish', async () => {
    const h = await start();
    const bob = await h.createAccount('Bob');
    const bobClient = await h.connectAs(bob);
    const errors = collectEvents<{ code: string }>(bobClient, 'error');

    for (let attempt = 0; attempt < 15; attempt += 1) {
      bobClient.emit('room:join-by-code', { roomCode: 'BURST' + String(attempt) + 'CODE' });
    }
    await roundTrip(bobClient);
    await settle(300);

    expect(errors.filter((error) => error.code === 'room.notFound')).toHaveLength(10);
    expect(errors.filter((error) => error.code === 'rateLimit.roomJoin')).toHaveLength(5);
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
    await h.roomRepository.updateParticipant(group.id, alice.user.id, { blockedByUserId: bob.user.id });
    await h.roomRepository.updateParticipant(group.id, carol.user.id, { blockedByUserId: alice.user.id });

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
    const other = await createGroup(aliceClient, 'Outro');
    await joinByCode(bobClient, group.roomCode);
    await joinByCode(bobClient, other.roomCode);
    await Promise.all([joinVisibleRooms(aliceClient), joinVisibleRooms(bobClient)]);

    const warmUp = waitForEvent(bobClient, 'message:new', (event: { content: string }) => event.content === 'aquecendo');
    aliceClient.emit('message:send', { roomId: group.id, content: 'aquecendo' });
    await warmUp;

    await dropTransport(bobClient);
    await h.roomService.removeMember(group.id, alice.user.id, bob.user.id);
    const sent = waitForEvent(aliceClient, 'message:new', (event: { content: string }) => event.content === 'depois da remoção');
    aliceClient.emit('message:send', { roomId: group.id, content: 'depois da remoção' });
    await sent;
    const stillMember = waitForEvent(aliceClient, 'message:new', (event: { content: string }) => event.content === 'na outra sala');
    aliceClient.emit('message:send', { roomId: other.id, content: 'na outra sala' });
    await stillMember;

    const received = collectEvents<{ roomId: string; content: string }>(bobClient, 'message:new');
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
    expect(received.filter((message) => message.roomId === other.id).map((message) => message.content)).toContain('na outra sala');
  });
});
