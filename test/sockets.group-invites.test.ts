import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { roomParticipants, rooms } from '@/database/schema.js';
import { hashInviteToken, matchesInviteToken } from '@/modules/rooms/room.invites.js';
import { fakeProof } from './support/invites.js';
import { fakeEnvelope, fakeInvite, newKeyId } from './support/room-keys.js';
import { collectEvents, roundTrip, settle, startSocketHarness, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;
type Account = Awaited<ReturnType<Harness['createAccount']>>;

interface InviteView {
  encryptedInvite: string;
  keyId: string;
}

interface Summary {
  id: string;
  invite: InviteView | null;
  roomCode?: string;
  currentKeyId: string | null;
}

interface ErrorEvent {
  code: string;
}

let harness: Harness | null = null;

async function start(): Promise<Harness> {
  harness = await startSocketHarness();
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function generation(roomId: string, senderId: string, recipients: string[], epoch = 1, keyId = newKeyId(), withInvite = true) {
  const invite = fakeInvite(keyId);
  return {
    payload: {
      roomId,
      keyId,
      epoch,
      keys: recipients.map((userId) => ({ userId, sealedKey: fakeEnvelope({ roomId, keyId, epoch, senderId, recipientId: userId }) })),
      ...(withInvite ? { invite: { tokenHash: invite.tokenHash, encryptedInvite: invite.encryptedInvite } } : {}),
    },
    invite,
    keyId,
  };
}

async function listRooms(client: TestClient): Promise<Summary[]> {
  const listed = waitForEvent<{ rooms: Summary[] }>(client, 'rooms:list');
  client.emit('rooms:get');
  return (await listed).rooms;
}

async function createGroupWithKey(owner: Account, ownerClient: TestClient) {
  const created = waitForEvent<{ room: Summary }>(ownerClient, 'room:created');
  ownerClient.emit('room:create-group', { roomName: 'Amigos' });
  const { room } = await created;
  const first = generation(room.id, owner.user.id, [owner.user.id]);
  const stored = waitForEvent(ownerClient, 'e2e:room-key');
  ownerClient.emit('e2e:publish-room-key', first.payload);
  await stored;
  return { roomId: room.id, first };
}

async function joinByInvite(client: TestClient, roomId: string, userId: string, inviteToken: string): Promise<{ room: Summary }> {
  const joined = waitForEvent<{ room: Summary }>(client, 'room:joined');
  client.emit('room:join-by-invite', { roomId, inviteToken, proof: fakeProof(userId) });
  return joined;
}

async function expectError(client: TestClient, event: string, payload: unknown, code: string): Promise<void> {
  const error = waitForEvent<ErrorEvent>(client, 'error');
  client.emit(event, payload);
  await expect(error).resolves.toMatchObject({ code });
}

describe('invite stored with the room key generation', () => {
  it('refuses a group generation without an invite and keeps the room untouched', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const aliceClient = await h.connectAs(alice);
    const group = await h.roomService.createGroupRoom('Amigos', alice.user.id);
    const missing = generation(group.id, alice.user.id, [alice.user.id], 1, newKeyId(), false);

    const rejected = waitForEvent<ErrorEvent & { event: string }>(aliceClient, 'e2e:room-key-rejected');
    aliceClient.emit('e2e:publish-room-key', missing.payload);

    await expect(rejected).resolves.toMatchObject({ code: 'e2e.inviteRequired', event: 'e2e:publish-room-key' });
    expect(await h.roomKeyRepository.getState(group.id)).toEqual({ currentEpoch: 0, currentKeyId: null, rotationRequired: null });
    expect(await h.roomKeyRepository.findForParticipantInRooms([group.id], alice.user.id)).toEqual([]);
  });

  it('stores the invite in the same write as the winning batch and shows it to members only', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const mallory = await h.createAccount('Mallory');
    const aliceClient = await h.connectAs(alice);
    const malloryClient = await h.connectAs(mallory);
    const { roomId, first } = await createGroupWithKey(alice, aliceClient);

    const room = await h.roomService.getRoomById(roomId);
    expect(room).toMatchObject({ inviteTokenHash: first.invite.tokenHash, encryptedInvite: first.invite.encryptedInvite, inviteKeyId: first.keyId });

    const [summary] = (await listRooms(aliceClient)).filter((candidate) => candidate.id === roomId);
    expect(summary?.invite).toEqual({ encryptedInvite: first.invite.encryptedInvite, keyId: first.keyId });
    expect(summary).not.toHaveProperty('roomCode');
    expect(JSON.stringify(summary)).not.toContain(first.invite.tokenHash);

    expect((await listRooms(malloryClient)).map((candidate) => candidate.id)).not.toContain(roomId);
    if (!room) {
      throw new Error('room missing');
    }
    const outsiderView = await h.roomService.buildSummary(room, mallory.user.id);
    expect(outsiderView.invite).toBeNull();
  });

  it('keeps the winner invite when a losing batch for the same epoch arrives', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const aliceClient = await h.connectAs(alice);
    const group = await h.roomService.createGroupRoom('Amigos', alice.user.id);
    const winner = generation(group.id, alice.user.id, [alice.user.id]);
    const loser = generation(group.id, alice.user.id, [alice.user.id]);

    const stored = waitForEvent(aliceClient, 'e2e:room-key');
    aliceClient.emit('e2e:publish-room-key', winner.payload);
    await stored;
    const rejected = waitForEvent<ErrorEvent>(aliceClient, 'e2e:room-key-rejected');
    aliceClient.emit('e2e:publish-room-key', loser.payload);
    await expect(rejected).resolves.toMatchObject({ code: 'e2e.roomKeyStale' });

    expect(await h.roomService.getRoomById(group.id)).toMatchObject({ inviteTokenHash: winner.invite.tokenHash, inviteKeyId: winner.keyId });
  });

  it('stores no invite when the batch itself is refused', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const group = await h.roomService.createGroupRoom('Amigos', alice.user.id);
    await h.joinGroup(group.id, bob.user.id);
    await h.db.update(rooms).set({ inviteTokenHash: null }).where(eq(rooms.id, group.id));
    const incomplete = generation(group.id, alice.user.id, [alice.user.id]);

    const rejected = waitForEvent<ErrorEvent>(aliceClient, 'e2e:room-key-rejected');
    aliceClient.emit('e2e:publish-room-key', incomplete.payload);
    await expect(rejected).resolves.toMatchObject({ code: 'e2e.roomKeyIncomplete' });

    expect(await h.roomService.getRoomById(group.id)).toMatchObject({ currentEpoch: 0, inviteTokenHash: undefined, encryptedInvite: undefined, inviteKeyId: undefined });
  });

  it('replaces the invite with every new generation, so the old token stops working after a rotation', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const carol = await h.createAccount('Carol');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const carolClient = await h.connectAs(carol);
    const { roomId, first } = await createGroupWithKey(alice, aliceClient);
    await joinByInvite(bobClient, roomId, bob.user.id, first.invite.inviteToken);

    const left = waitForEvent(bobClient, 'group:left');
    bobClient.emit('group:leave', { roomId });
    await left;
    expect(await h.roomService.getRoomById(roomId)).toMatchObject({ rotationRequired: 2, inviteTokenHash: undefined });
    await expectError(carolClient, 'room:join-by-invite', { roomId, inviteToken: first.invite.inviteToken, proof: fakeProof(carol.user.id) }, 'room.invalidInvite');

    const second = generation(roomId, alice.user.id, [alice.user.id], 2);
    const stored = waitForEvent(aliceClient, 'e2e:room-key');
    aliceClient.emit('e2e:publish-room-key', second.payload);
    await stored;

    const [summary] = (await listRooms(aliceClient)).filter((candidate) => candidate.id === roomId);
    expect(summary?.invite).toEqual({ encryptedInvite: second.invite.encryptedInvite, keyId: second.keyId });
    await joinByInvite(carolClient, roomId, carol.user.id, second.invite.inviteToken);
  });

  it('never stores an invite on a private room', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    const first = generation(room.id, alice.user.id, [alice.user.id, bob.user.id]);

    const stored = waitForEvent(aliceClient, 'e2e:room-key');
    aliceClient.emit('e2e:publish-room-key', first.payload);
    await stored;

    expect(await h.roomService.getRoomById(room.id)).toMatchObject({ currentEpoch: 1, inviteTokenHash: undefined, encryptedInvite: undefined });
    const [summary] = (await listRooms(aliceClient)).filter((candidate) => candidate.id === room.id);
    expect(summary?.invite).toBeNull();
  });

  it('rejects malformed invites in a batch', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const aliceClient = await h.connectAs(alice);
    const group = await h.roomService.createGroupRoom('Amigos', alice.user.id);
    const first = generation(group.id, alice.user.id, [alice.user.id]);

    await expectError(aliceClient, 'e2e:publish-room-key', { ...first.payload, invite: { tokenHash: 'NOT-HEX', encryptedInvite: 'x' } }, 'validation.invalidPayload');
    expect(await h.roomKeyRepository.getState(group.id)).toMatchObject({ currentEpoch: 0 });
  });
});

describe('joining a group by invite', () => {
  it('adds the member, stores the proof and sends it to members with every key request', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const { roomId, first } = await createGroupWithKey(alice, aliceClient);
    const rotations = collectEvents(aliceClient, 'e2e:rotation-required');
    const joinRequest = waitForEvent(aliceClient, 'e2e:key-request');
    const memberJoined = waitForEvent(aliceClient, 'group:user-joined');

    const { room } = await joinByInvite(bobClient, roomId, bob.user.id, first.invite.inviteToken);

    await expect(joinRequest).resolves.toEqual({ roomId, requesterId: bob.user.id, proof: fakeProof(bob.user.id) });
    await memberJoined;
    expect(room.invite).toEqual({ encryptedInvite: first.invite.encryptedInvite, keyId: first.keyId });
    expect((await h.roomService.getRoomById(roomId))?.participants).toEqual([alice.user.id, bob.user.id]);
    expect(await h.roomService.findInviteProof(roomId, bob.user.id)).toBe(fakeProof(bob.user.id));
    expect(await h.roomKeyRepository.getState(roomId)).toMatchObject({ currentEpoch: 1, rotationRequired: null });

    const again = waitForEvent(aliceClient, 'e2e:key-request');
    bobClient.emit('e2e:request-room-key', { roomId });
    await expect(again).resolves.toEqual({ roomId, requesterId: bob.user.id, proof: fakeProof(bob.user.id) });
    await settle(50);
    expect(rotations).toHaveLength(0);
  });

  it('refuses a wrong token, a token of another group, a missing room and a private room alike', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const target = await createGroupWithKey(alice, aliceClient);
    const other = await createGroupWithKey(alice, aliceClient);
    const privateRoom = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    const keyRequests = collectEvents(aliceClient, 'e2e:key-request');
    const proof = fakeProof(bob.user.id);

    await expectError(bobClient, 'room:join-by-invite', { roomId: target.roomId, inviteToken: fakeInvite('wrong').inviteToken, proof }, 'room.invalidInvite');
    await expectError(bobClient, 'room:join-by-invite', { roomId: target.roomId, inviteToken: other.first.invite.inviteToken, proof }, 'room.invalidInvite');
    await expectError(bobClient, 'room:join-by-invite', { roomId: 'missing-room', inviteToken: target.first.invite.inviteToken, proof }, 'room.invalidInvite');
    await expectError(bobClient, 'room:join-by-invite', { roomId: privateRoom.id, inviteToken: target.first.invite.inviteToken, proof }, 'room.invalidInvite');
    await expectError(bobClient, 'room:join-by-invite', { roomId: target.roomId, inviteToken: target.first.invite.tokenHash, proof }, 'room.invalidInvite');
    await expectError(bobClient, 'room:join-by-invite', { roomId: target.roomId, inviteToken: target.first.invite.inviteToken }, 'validation.invalidPayload');

    await roundTrip(aliceClient);
    expect((await h.roomService.getRoomById(target.roomId))?.participants).toEqual([alice.user.id]);
    expect(keyRequests).toHaveLength(0);
  });

  it('refuses a banned user even with the current token', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const { roomId, first } = await createGroupWithKey(alice, aliceClient);
    await joinByInvite(bobClient, roomId, bob.user.id, first.invite.inviteToken);
    await h.roomService.removeMember(roomId, alice.user.id, bob.user.id);
    await h.db.update(rooms).set({ inviteTokenHash: first.invite.tokenHash, rotationRequired: null }).where(eq(rooms.id, roomId));

    await expectError(bobClient, 'room:join-by-invite', { roomId, inviteToken: first.invite.inviteToken, proof: fakeProof(bob.user.id) }, 'room.notFound');
    expect(await h.db.select().from(roomParticipants).where(eq(roomParticipants.userId, bob.user.id))).toEqual([]);
  });

  it('does not let a room code grant access to a group', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const { roomId } = await createGroupWithKey(alice, aliceClient);
    await h.db.update(rooms).set({ roomCode: 'OLDCODE123' }).where(eq(rooms.id, roomId));

    await expectError(bobClient, 'room:join-by-code', { roomCode: 'OLDCODE123' }, 'room.inviteLinkRequired');
    expect((await h.roomService.getRoomById(roomId))?.participants).toEqual([alice.user.id]);
  });
});

describe('resetting the invite link', () => {
  async function groupWithAdmin(h: Harness) {
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const mallory = await h.createAccount('Mallory');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const malloryClient = await h.connectAs(mallory);
    const { roomId, first } = await createGroupWithKey(alice, aliceClient);
    await joinByInvite(bobClient, roomId, bob.user.id, first.invite.inviteToken);
    await h.roomService.promoteAdmin(roomId, alice.user.id, bob.user.id);
    return { alice, bob, mallory, aliceClient, bobClient, malloryClient, roomId, first };
  }

  it('lets the owner replace the invite under the current key, revoking the old token', async () => {
    const h = await start();
    const { mallory, aliceClient, malloryClient, roomId, first } = await groupWithAdmin(h);
    const renewed = fakeInvite('renewed');
    const errors = collectEvents(aliceClient, 'error');

    aliceClient.emit('room:reset-invite', { roomId, invite: { tokenHash: renewed.tokenHash, encryptedInvite: renewed.encryptedInvite, keyId: first.keyId } });
    await roundTrip(aliceClient);

    expect(errors).toEqual([]);
    expect(await h.roomService.getRoomById(roomId)).toMatchObject({ inviteTokenHash: renewed.tokenHash, encryptedInvite: renewed.encryptedInvite, inviteKeyId: first.keyId });
    const [summary] = (await listRooms(aliceClient)).filter((candidate) => candidate.id === roomId);
    expect(summary?.invite).toEqual({ encryptedInvite: renewed.encryptedInvite, keyId: first.keyId });

    await expectError(malloryClient, 'room:join-by-invite', { roomId, inviteToken: first.invite.inviteToken, proof: fakeProof(mallory.user.id) }, 'room.invalidInvite');
    await joinByInvite(malloryClient, roomId, mallory.user.id, renewed.inviteToken);
  });

  it('refuses a reset from an admin who is not the owner and from a non-member', async () => {
    const h = await start();
    const { bobClient, malloryClient, roomId, first } = await groupWithAdmin(h);
    const renewed = fakeInvite('renewed');
    const payload = { roomId, invite: { tokenHash: renewed.tokenHash, encryptedInvite: renewed.encryptedInvite, keyId: first.keyId } };

    await expectError(bobClient, 'room:reset-invite', payload, 'room.inviteResetRequiresOwner');
    await expectError(malloryClient, 'room:reset-invite', payload, 'room.notFound');
    expect(await h.roomService.getRoomById(roomId)).toMatchObject({ inviteTokenHash: first.invite.tokenHash });
  });

  it('refuses a reset under a stale key or while a rotation is pending', async () => {
    const h = await start();
    const { alice, bob, aliceClient, roomId, first } = await groupWithAdmin(h);
    const renewed = fakeInvite('renewed');
    const invite = { tokenHash: renewed.tokenHash, encryptedInvite: renewed.encryptedInvite };

    await expectError(aliceClient, 'room:reset-invite', { roomId, invite: { ...invite, keyId: newKeyId() } }, 'room.inviteKeyStale');

    await h.roomService.removeMember(roomId, alice.user.id, bob.user.id);
    await expectError(aliceClient, 'room:reset-invite', { roomId, invite: { ...invite, keyId: first.keyId } }, 'room.inviteKeyStale');
    expect(await h.roomService.getRoomById(roomId)).toMatchObject({ inviteTokenHash: undefined, rotationRequired: 2 });
  });

  it('refuses a reset with a malformed invite', async () => {
    const h = await start();
    const { aliceClient, roomId, first } = await groupWithAdmin(h);

    await expectError(aliceClient, 'room:reset-invite', { roomId, invite: { tokenHash: 'abc', encryptedInvite: 'x', keyId: first.keyId } }, 'validation.invalidPayload');
    expect(await h.roomService.getRoomById(roomId)).toMatchObject({ inviteTokenHash: first.invite.tokenHash });
  });
});

describe('invite token comparison', () => {
  it('matches only the sha256 of the exact token and never an empty or malformed hash', () => {
    const token = fakeInvite('compare').inviteToken;
    expect(matchesInviteToken(token, hashInviteToken(token))).toBe(true);
    expect(matchesInviteToken(`${token}x`, hashInviteToken(token))).toBe(false);
    expect(matchesInviteToken(token, undefined)).toBe(false);
    expect(matchesInviteToken(token, '')).toBe(false);
    expect(matchesInviteToken(token, hashInviteToken(token).toUpperCase())).toBe(false);
    expect(matchesInviteToken(token, hashInviteToken(token).slice(2))).toBe(false);
  });
});
