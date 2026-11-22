import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { collectEvents, roundTrip, settle, startSocketHarness, waitForDisconnect, waitForEvent, type TestClient } from './support/socket-harness.js';
import { fakeField, fakeInvite } from './support/room-keys.js';
import { fakeProof, seedInvite } from './support/invites.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

interface RoomPayload {
  room: { id: string };
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

async function createGroup(client: TestClient, roomName: string): Promise<{ id: string }> {
  const created = waitForEvent<RoomPayload>(client, 'room:created');
  client.emit('room:create-group', { roomName });
  const { room } = await created;
  return { id: room.id };
}

async function joinByInvite(h: Harness, client: TestClient, roomId: string, userId: string): Promise<string> {
  const { inviteToken } = await seedInvite(h.db, roomId);
  const joined = waitForEvent(client, 'room:joined');
  client.emit('room:join-by-invite', { roomId, inviteToken, proof: fakeProof(userId) });
  await joined;
  return inviteToken;
}

describe('presence privacy', () => {
  it('sends presence and profile changes only to users who share a room', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const stranger = await h.createAccount('Stranger');
    await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    await h.roomService.createPrivateRoom(bob.user.id, alice.user.id);

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

describe('unaccepted private rooms', () => {
  it('give the creator no presence, profile or avatar edge to the target until the room is visible to the target', async () => {
    const h = await start();
    const attacker = await h.createAccount('Attacker');
    const victim = await h.createAccount('Victim');
    const attackerClient = await h.connectAs(attacker);

    const joined = waitForEvent(attackerClient, 'room:joined');
    attackerClient.emit('room:create-private', { targetNickname: 'Victim' });
    await joined;

    expect(await h.roomService.getContactIds(victim.user.id)).toEqual([victim.user.id]);
    expect(await h.roomService.getContactIds(attacker.user.id)).toEqual([attacker.user.id]);

    const seen = ['user:online', 'user:offline', 'user:profile-updated', 'user:avatar-updated'].map((event) =>
      collectEvents(attackerClient, event),
    );
    const victimClient = await h.connectAs(victim);
    victimClient.emit('user:update-status-text', { statusText: 'private' });
    await settle(200);
    victimClient.disconnect();
    await settle(200);

    expect(seen.every((events) => events.length === 0)).toBe(true);
  });

  it('opens the presence edge once the target makes the room visible', async () => {
    const h = await start();
    const attacker = await h.createAccount('Attacker');
    const victim = await h.createAccount('Victim');
    await h.roomService.createPrivateRoom(attacker.user.id, victim.user.id);
    await h.roomService.createPrivateRoom(victim.user.id, attacker.user.id);

    expect(await h.roomService.getContactIds(attacker.user.id)).toContain(victim.user.id);
    expect(await h.roomService.getContactIds(victim.user.id)).toContain(attacker.user.id);
  });

  it('caps how many new private rooms and unknown nicknames one user can probe', async () => {
    const h = await start();
    const attacker = await h.createAccount('Attacker');
    const attackerClient = await h.connectAs(attacker);

    let limited = 0;
    for (let index = 0; index < 12; index += 1) {
      const error = waitForEvent<{ code: string }>(attackerClient, 'error');
      attackerClient.emit('room:create-private', { targetNickname: `Nobody${index}` });
      if ((await error).code === 'rateLimit.privateRoomCreate') {
        limited += 1;
      }
    }

    expect(limited).toBe(2);
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

describe('group membership enforcement', () => {
  it('bans a removed member, revokes the invite until the next key generation and hides it from the removed member', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const carol = await h.createAccount('Carol');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const carolClient = await h.connectAs(carol);
    const group = await createGroup(aliceClient, 'Amigos');
    await h.establishRoomKey(group.id);
    const inviteToken = await joinByInvite(h, bobClient, group.id, bob.user.id);
    await joinByInvite(h, carolClient, group.id, carol.user.id);
    const bobUpdates = collectEvents(bobClient, 'group:user-left');

    const notified = waitForEvent<Record<string, unknown>>(carolClient, 'group:user-left');
    const left = waitForEvent(bobClient, 'group:left');
    aliceClient.emit('group:remove-member', { roomId: group.id, userId: bob.user.id });
    const update = await notified;
    await left;

    expect(update.userId).toBe(bob.user.id);
    expect(update).not.toHaveProperty('roomCode');
    expect(bobUpdates).toHaveLength(0);
    const revoked = await h.roomService.getRoomById(group.id);
    expect(revoked?.inviteTokenHash).toBeUndefined();
    expect(revoked?.encryptedInvite).toBeDefined();
    expect(revoked?.inviteKeyId).toBe(revoked?.currentKeyId);

    const rejected = waitForEvent<{ code: string }>(bobClient, 'error');
    bobClient.emit('room:join-by-invite', { roomId: group.id, inviteToken, proof: fakeProof(bob.user.id) });
    await expect(rejected).resolves.toMatchObject({ code: 'room.removedFromGroup' });

    const renewed = await seedInvite(h.db, group.id, 'renewed');
    const banned = waitForEvent<{ code: string }>(bobClient, 'error');
    bobClient.emit('room:join-by-invite', { roomId: group.id, inviteToken: renewed.inviteToken, proof: fakeProof(bob.user.id) });
    await expect(banned).resolves.toMatchObject({ code: 'room.removedFromGroup' });

    const room = await h.roomService.getRoomById(group.id);
    expect(room?.participants).not.toContain(bob.user.id);
  });

  it('lets a member who left voluntarily join again with a valid invite', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const group = await createGroup(aliceClient, 'Amigos');
    await joinByInvite(h, bobClient, group.id, bob.user.id);

    const left = waitForEvent(bobClient, 'group:left');
    bobClient.emit('group:leave', { roomId: group.id });
    await left;

    await joinByInvite(h, bobClient, group.id, bob.user.id);
    const room = await h.roomService.getRoomById(group.id);
    expect(room?.participants).toContain(bob.user.id);
  });

  it('stops accepting invite tokens after ten failed attempts in an hour', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const group = await createGroup(aliceClient, 'Amigos');
    const { inviteToken } = await seedInvite(h.db, group.id);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const failed = waitForEvent<{ code: string }>(bobClient, 'error');
      bobClient.emit('room:join-by-invite', { roomId: group.id, inviteToken: fakeInvite(`wrong-${attempt}`).inviteToken, proof: fakeProof(bob.user.id) });
      await expect(failed).resolves.toMatchObject({ code: 'room.invalidInvite' });
    }

    const limited = waitForEvent<{ code: string }>(bobClient, 'error');
    bobClient.emit('room:join-by-invite', { roomId: group.id, inviteToken, proof: fakeProof(bob.user.id) });
    await expect(limited).resolves.toMatchObject({ code: 'rateLimit.roomJoin' });
    expect((await h.roomService.getRoomById(group.id))?.participants).not.toContain(bob.user.id);
  });

  it('shares the join limit between room codes and invite links', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const group = await createGroup(aliceClient, 'Amigos');
    const { inviteToken } = await seedInvite(h.db, group.id);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const failed = waitForEvent<{ code: string }>(bobClient, 'error');
      bobClient.emit('room:join-by-code', { roomCode: `WRONG${attempt}CODE` });
      await expect(failed).resolves.toMatchObject({ code: 'room.notFound' });
    }

    const limited = waitForEvent<{ code: string }>(bobClient, 'error');
    bobClient.emit('room:join-by-invite', { roomId: group.id, inviteToken, proof: fakeProof(bob.user.id) });
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

  it('counts parallel invite attempts before they finish', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const group = await h.roomService.createGroupRoom(alice.user.id);
    await seedInvite(h.db, group.id);
    const bobClient = await h.connectAs(bob);
    const errors = collectEvents<{ code: string }>(bobClient, 'error');

    for (let attempt = 0; attempt < 15; attempt += 1) {
      bobClient.emit('room:join-by-invite', { roomId: group.id, inviteToken: fakeInvite(`burst-${attempt}`).inviteToken, proof: fakeProof(bob.user.id) });
    }
    await roundTrip(bobClient);
    await settle(300);

    expect(errors.filter((error) => error.code === 'room.invalidInvite')).toHaveLength(10);
    expect(errors.filter((error) => error.code === 'rateLimit.roomJoin')).toHaveLength(5);
  });

  it('ignores block requests inside groups', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const group = await createGroup(aliceClient, 'Amigos');
    await joinByInvite(h, bobClient, group.id, bob.user.id);
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
    const group = await h.roomService.createGroupRoom(alice.user.id);
    await h.joinGroup(group.id, bob.user.id);
    await h.joinGroup(group.id, carol.user.id);
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
    await joinByInvite(h, bobClient, group.id, bob.user.id);
    await joinByInvite(h, bobClient, other.id, bob.user.id);
    await Promise.all([joinVisibleRooms(aliceClient), joinVisibleRooms(bobClient)]);
    await h.establishRoomKey(group.id);
    await h.establishRoomKey(other.id);

    const warmUp = waitForEvent(bobClient, 'message:new', (event: { content: string }) => event.content === fakeField('aquecendo'));
    aliceClient.emit('message:send', { roomId: group.id, content: fakeField('aquecendo'), messageId: randomUUID() });
    await warmUp;

    await dropTransport(bobClient);
    await h.roomService.removeMember(group.id, alice.user.id, bob.user.id);
    const rotatedKeyId = await h.establishRoomKey(group.id);
    const sent = waitForEvent(aliceClient, 'message:new', (event: { content: string }) => event.content === fakeField('depois da remoção', rotatedKeyId));
    aliceClient.emit('message:send', { roomId: group.id, content: fakeField('depois da remoção', rotatedKeyId), messageId: randomUUID() });
    await sent;
    const stillMember = waitForEvent(aliceClient, 'message:new', (event: { content: string }) => event.content === fakeField('na outra sala'));
    aliceClient.emit('message:send', { roomId: other.id, content: fakeField('na outra sala'), messageId: randomUUID() });
    await stillMember;

    const received = collectEvents<{ roomId: string; content: string }>(bobClient, 'message:new');
    const reconnected = new Promise<void>((resolve) => bobClient.once('connect', () => resolve()));
    bobClient.connect();
    await reconnected;
    await roundTrip(bobClient);

    expect(bobClient.recovered).toBe(true);
    expect(h.io.sockets.adapter.rooms.get(group.id)?.has(bobClient.id ?? '')).toBeFalsy();
    expect(h.io.sockets.adapter.rooms.get(`user:${bob.user.id}`)?.has(bobClient.id ?? '')).toBe(true);

    const later = waitForEvent(aliceClient, 'message:new', (event: { content: string }) => event.content === fakeField('ainda depois', rotatedKeyId));
    aliceClient.emit('message:send', { roomId: group.id, content: fakeField('ainda depois', rotatedKeyId), messageId: randomUUID() });
    await later;
    await settle(100);

    expect(received.filter((message) => message.roomId === group.id)).toHaveLength(0);
    expect(received.filter((message) => message.roomId === other.id).map((message) => message.content)).toContain(fakeField('na outra sala'));
  });
});
