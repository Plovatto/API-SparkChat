import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { roomParticipants, rooms } from '@/database/schema.js';
import { hashInviteToken, matchesInviteToken } from '@/modules/rooms/room.invites.js';
import { fakeProof } from './support/invites.js';
import { fakeEnvelope, fakeInvite, fakeRoster, newKeyId } from './support/room-keys.js';
import { collectEvents, roundTrip, settle, startSocketHarness, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;
type Account = Awaited<ReturnType<Harness['createAccount']>>;

interface InviteView {
  encryptedInvite: string;
  keyId: string;
  active: boolean;
}

interface RosterView {
  encryptedRoster: string;
  keyId: string;
}

interface Summary {
  id: string;
  invite: InviteView | null;
  roster: RosterView | null;
  inviteProofs: { userId: string; proof: string }[];
  roomCode?: string;
  currentKeyId: string | null;
}

interface ErrorEvent {
  code: string;
  event?: string;
}

interface InviteUpdate {
  roomId: string;
  invite: InviteView | null;
  roster: RosterView | null;
}

let harness: Harness | null = null;

async function start(options: Parameters<typeof startSocketHarness>[0] = {}): Promise<Harness> {
  harness = await startSocketHarness(options);
  return harness;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

interface GenerationOptions {
  epoch?: number;
  keyId?: string;
  withInvite?: boolean;
  withRoster?: boolean;
}

function generation(roomId: string, senderId: string, recipients: string[], options: GenerationOptions = {}) {
  const { epoch = 1, keyId = newKeyId(), withInvite = true, withRoster = true } = options;
  const invite = fakeInvite(keyId);
  const roster = fakeRoster(keyId);
  return {
    payload: {
      roomId,
      keyId,
      epoch,
      keys: recipients.map((userId) => ({ userId, sealedKey: fakeEnvelope({ roomId, keyId, epoch, senderId, recipientId: userId }) })),
      ...(withInvite ? { invite: { tokenHash: invite.tokenHash, encryptedInvite: invite.encryptedInvite } } : {}),
      ...(withRoster ? { roster } : {}),
    },
    invite,
    roster,
    keyId,
  };
}

async function listRooms(client: TestClient): Promise<Summary[]> {
  const listed = waitForEvent<{ rooms: Summary[] }>(client, 'rooms:list');
  client.emit('rooms:get');
  return (await listed).rooms;
}

async function summaryOf(client: TestClient, roomId: string): Promise<Summary | undefined> {
  return (await listRooms(client)).find((candidate) => candidate.id === roomId);
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

async function publishGeneration(client: TestClient, payload: ReturnType<typeof generation>['payload']): Promise<void> {
  const stored = waitForEvent(client, 'e2e:room-key');
  client.emit('e2e:publish-room-key', payload);
  await stored;
}

async function joinByInvite(client: TestClient, roomId: string, userId: string, inviteToken: string): Promise<{ room: Summary }> {
  const joined = waitForEvent<{ room: Summary }>(client, 'room:joined');
  client.emit('room:join-by-invite', { roomId, inviteToken, proof: fakeProof(userId) });
  return joined;
}

async function expectError(client: TestClient, event: string, payload: unknown, expected: ErrorEvent): Promise<void> {
  const error = waitForEvent<ErrorEvent>(client, 'error');
  client.emit(event, payload);
  await expect(error).resolves.toMatchObject(expected);
}

describe('invite and roster stored with the room key generation', () => {
  it('refuses a group generation without an invite or without a roster and keeps the room untouched', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const aliceClient = await h.connectAs(alice);
    const group = await h.roomService.createGroupRoom('Amigos', alice.user.id);

    const noInvite = waitForEvent<ErrorEvent>(aliceClient, 'e2e:room-key-rejected');
    aliceClient.emit('e2e:publish-room-key', generation(group.id, alice.user.id, [alice.user.id], { withInvite: false }).payload);
    await expect(noInvite).resolves.toMatchObject({ code: 'e2e.inviteRequired', event: 'e2e:publish-room-key' });

    const noRoster = waitForEvent<ErrorEvent>(aliceClient, 'e2e:room-key-rejected');
    aliceClient.emit('e2e:publish-room-key', generation(group.id, alice.user.id, [alice.user.id], { withRoster: false }).payload);
    await expect(noRoster).resolves.toMatchObject({ code: 'e2e.rosterRequired', event: 'e2e:publish-room-key' });

    expect(await h.roomKeyRepository.getState(group.id)).toEqual({ currentEpoch: 0, currentKeyId: null, rotationRequired: null });
    expect(await h.roomKeyRepository.findForParticipantInRooms([group.id], alice.user.id)).toEqual([]);
  });

  it('refuses a group batch without a roster even when it reaches the repository directly', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const group = await h.roomService.createGroupRoom('Amigos', alice.user.id);
    const keyId = newKeyId();

    const outcome = await h.roomKeyRepository.publish({
      mode: 'generation',
      roomId: group.id,
      keyId,
      epoch: 1,
      senderId: alice.user.id,
      keys: [{ userId: alice.user.id, sealedKey: fakeEnvelope({ roomId: group.id, keyId, epoch: 1, senderId: alice.user.id, recipientId: alice.user.id }) }],
      invite: fakeInvite(keyId),
    });

    expect(outcome).toBe('stale');
    expect(await h.roomKeyRepository.getState(group.id)).toMatchObject({ currentEpoch: 0 });
  });

  it('stores invite and roster in the same write as the winning batch and shows them to members only', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const mallory = await h.createAccount('Mallory');
    const aliceClient = await h.connectAs(alice);
    const malloryClient = await h.connectAs(mallory);
    const { roomId, first } = await createGroupWithKey(alice, aliceClient);

    const room = await h.roomService.getRoomById(roomId);
    expect(room).toMatchObject({
      inviteTokenHash: first.invite.tokenHash,
      encryptedInvite: first.invite.encryptedInvite,
      inviteKeyId: first.keyId,
      encryptedRoster: first.roster,
      rosterKeyId: first.keyId,
    });

    const summary = await summaryOf(aliceClient, roomId);
    expect(summary?.invite).toEqual({ encryptedInvite: first.invite.encryptedInvite, keyId: first.keyId, active: true });
    expect(summary?.roster).toEqual({ encryptedRoster: first.roster, keyId: first.keyId });
    expect(summary).not.toHaveProperty('roomCode');
    expect(JSON.stringify(summary)).not.toContain(first.invite.tokenHash);

    expect((await listRooms(malloryClient)).map((candidate) => candidate.id)).not.toContain(roomId);
    if (!room) {
      throw new Error('room missing');
    }
    const outsiderView = await h.roomService.buildSummary(room, mallory.user.id);
    expect(outsiderView).toMatchObject({ invite: null, roster: null, inviteProofs: [] });
  });

  it('keeps the winner invite and roster when a losing batch for the same epoch arrives', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const aliceClient = await h.connectAs(alice);
    const group = await h.roomService.createGroupRoom('Amigos', alice.user.id);
    const winner = generation(group.id, alice.user.id, [alice.user.id]);
    const loser = generation(group.id, alice.user.id, [alice.user.id]);

    await publishGeneration(aliceClient, winner.payload);
    const rejected = waitForEvent<ErrorEvent>(aliceClient, 'e2e:room-key-rejected');
    aliceClient.emit('e2e:publish-room-key', loser.payload);
    await expect(rejected).resolves.toMatchObject({ code: 'e2e.roomKeyStale' });

    expect(await h.roomService.getRoomById(group.id)).toMatchObject({
      inviteTokenHash: winner.invite.tokenHash,
      inviteKeyId: winner.keyId,
      encryptedRoster: winner.roster,
      rosterKeyId: winner.keyId,
    });
  });

  it('stores nothing when the batch itself is refused', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const group = await h.roomService.createGroupRoom('Amigos', alice.user.id);
    await h.joinGroup(group.id, bob.user.id);
    await h.db.update(rooms).set({ inviteTokenHash: null }).where(eq(rooms.id, group.id));

    const rejected = waitForEvent<ErrorEvent>(aliceClient, 'e2e:room-key-rejected');
    aliceClient.emit('e2e:publish-room-key', generation(group.id, alice.user.id, [alice.user.id]).payload);
    await expect(rejected).resolves.toMatchObject({ code: 'e2e.roomKeyIncomplete' });

    expect(await h.roomService.getRoomById(group.id)).toMatchObject({
      currentEpoch: 0,
      inviteTokenHash: undefined,
      encryptedInvite: undefined,
      inviteKeyId: undefined,
      encryptedRoster: undefined,
      rosterKeyId: undefined,
    });
  });

  it('replaces invite and roster with every new generation, so the old token stops working after a rotation', async () => {
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
    expect(await h.roomService.getRoomById(roomId)).toMatchObject({
      rotationRequired: 2,
      inviteTokenHash: undefined,
      encryptedInvite: first.invite.encryptedInvite,
      inviteKeyId: first.keyId,
      encryptedRoster: first.roster,
      rosterKeyId: first.keyId,
    });
    expect((await summaryOf(aliceClient, roomId))?.invite).toEqual({ encryptedInvite: first.invite.encryptedInvite, keyId: first.keyId, active: false });
    await expectError(
      carolClient,
      'room:join-by-invite',
      { roomId, inviteToken: first.invite.inviteToken, proof: fakeProof(carol.user.id) },
      { code: 'room.invalidInvite', event: 'room:join-by-invite' },
    );

    const second = generation(roomId, alice.user.id, [alice.user.id], { epoch: 2 });
    await publishGeneration(aliceClient, second.payload);

    const summary = await summaryOf(aliceClient, roomId);
    expect(summary?.invite).toEqual({ encryptedInvite: second.invite.encryptedInvite, keyId: second.keyId, active: true });
    expect(summary?.roster).toEqual({ encryptedRoster: second.roster, keyId: second.keyId });
    await joinByInvite(carolClient, roomId, carol.user.id, second.invite.inviteToken);
  });

  it('never stores an invite or roster on a private room', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);

    await publishGeneration(aliceClient, generation(room.id, alice.user.id, [alice.user.id, bob.user.id]).payload);

    expect(await h.roomService.getRoomById(room.id)).toMatchObject({ currentEpoch: 1, inviteTokenHash: undefined, encryptedInvite: undefined, encryptedRoster: undefined });
    expect(await summaryOf(aliceClient, room.id)).toMatchObject({ invite: null, roster: null, inviteProofs: [] });
  });

  it('rejects malformed invites and rosters in a batch', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const aliceClient = await h.connectAs(alice);
    const group = await h.roomService.createGroupRoom('Amigos', alice.user.id);
    const first = generation(group.id, alice.user.id, [alice.user.id]);

    await expectError(aliceClient, 'e2e:publish-room-key', { ...first.payload, invite: { tokenHash: 'NOT-HEX', encryptedInvite: 'x' } }, { code: 'validation.invalidPayload' });
    await expectError(aliceClient, 'e2e:publish-room-key', { ...first.payload, roster: 'x'.repeat(40 * 1024) }, { code: 'validation.invalidPayload' });
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
    expect(room.invite).toEqual({ encryptedInvite: first.invite.encryptedInvite, keyId: first.keyId, active: true });
    expect(room.inviteProofs).toEqual([{ userId: bob.user.id, proof: fakeProof(bob.user.id) }]);
    expect((await h.roomService.getRoomById(roomId))?.participants).toEqual([alice.user.id, bob.user.id]);
    expect(await h.roomService.findInviteProof(roomId, bob.user.id)).toBe(fakeProof(bob.user.id));
    expect(await h.roomKeyRepository.getState(roomId)).toMatchObject({ currentEpoch: 1, rotationRequired: null });
    expect((await summaryOf(aliceClient, roomId))?.inviteProofs).toEqual([{ userId: bob.user.id, proof: fakeProof(bob.user.id) }]);

    const again = waitForEvent(aliceClient, 'e2e:key-request');
    bobClient.emit('e2e:request-room-key', { roomId });
    await expect(again).resolves.toEqual({ roomId, requesterId: bob.user.id, proof: fakeProof(bob.user.id) });
    await settle(50);
    expect(rotations).toHaveLength(0);
  });

  it('keeps forwarding the stored proof when the member asks again from a new connection', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const { roomId, first } = await createGroupWithKey(alice, aliceClient);
    await joinByInvite(bobClient, roomId, bob.user.id, first.invite.inviteToken);
    bobClient.disconnect();

    const reconnected = await h.connectAs(bob);
    await listRooms(reconnected);
    const requested = waitForEvent(aliceClient, 'e2e:key-request');
    reconnected.emit('e2e:request-room-key', { roomId, proof: 'ignored-client-proof-value' });
    await expect(requested).resolves.toEqual({ roomId, requesterId: bob.user.id, proof: fakeProof(bob.user.id) });
  });

  it('refuses a wrong token, a token of another group, a missing room and a private room alike, naming the event', async () => {
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
    const invalid = { code: 'room.invalidInvite', event: 'room:join-by-invite' };

    await expectError(bobClient, 'room:join-by-invite', { roomId: target.roomId, inviteToken: fakeInvite('wrong').inviteToken, proof }, invalid);
    await expectError(bobClient, 'room:join-by-invite', { roomId: target.roomId, inviteToken: other.first.invite.inviteToken, proof }, invalid);
    await expectError(bobClient, 'room:join-by-invite', { roomId: 'missing-room', inviteToken: target.first.invite.inviteToken, proof }, invalid);
    await expectError(bobClient, 'room:join-by-invite', { roomId: privateRoom.id, inviteToken: target.first.invite.inviteToken, proof }, invalid);
    await expectError(bobClient, 'room:join-by-invite', { roomId: target.roomId, inviteToken: target.first.invite.tokenHash, proof }, invalid);
    await expectError(
      bobClient,
      'room:join-by-invite',
      { roomId: target.roomId, inviteToken: target.first.invite.inviteToken },
      { code: 'validation.invalidPayload', event: 'room:join-by-invite' },
    );

    await roundTrip(aliceClient);
    expect((await h.roomService.getRoomById(target.roomId))?.participants).toEqual([alice.user.id]);
    expect(keyRequests).toHaveLength(0);
  });

  it('refuses the join when the invite changes between the check and the insert', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const { roomId, first } = await createGroupWithKey(alice, aliceClient);
    const addParticipant = h.roomRepository.addParticipant.bind(h.roomRepository);
    vi.spyOn(h.roomRepository, 'addParticipant').mockImplementation(async (...args) => {
      await h.db.update(rooms).set({ inviteTokenHash: fakeInvite('replaced').tokenHash }).where(eq(rooms.id, roomId));
      return addParticipant(...args);
    });

    await expectError(
      bobClient,
      'room:join-by-invite',
      { roomId, inviteToken: first.invite.inviteToken, proof: fakeProof(bob.user.id) },
      { code: 'room.invalidInvite', event: 'room:join-by-invite' },
    );
    expect(await h.db.select().from(roomParticipants).where(eq(roomParticipants.userId, bob.user.id))).toEqual([]);
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

    await expectError(
      bobClient,
      'room:join-by-invite',
      { roomId, inviteToken: first.invite.inviteToken, proof: fakeProof(bob.user.id) },
      { code: 'room.notFound', event: 'room:join-by-invite' },
    );
    expect(await h.db.select().from(roomParticipants).where(eq(roomParticipants.userId, bob.user.id))).toEqual([]);
  });

  it('answers a group room code exactly like an unknown code', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const { roomId } = await createGroupWithKey(alice, aliceClient);
    await h.db.update(rooms).set({ roomCode: 'OLDCODE123' }).where(eq(rooms.id, roomId));

    const groupCode = waitForEvent<ErrorEvent>(bobClient, 'error');
    bobClient.emit('room:join-by-code', { roomCode: 'OLDCODE123' });
    const unknownCode = waitForEvent<ErrorEvent>(bobClient, 'error');
    const groupAnswer = await groupCode;
    bobClient.emit('room:join-by-code', { roomCode: 'NOSUCH1234' });

    expect(await unknownCode).toEqual(groupAnswer);
    expect(groupAnswer).toMatchObject({ code: 'room.notFound' });
    expect((await h.roomService.getRoomById(roomId))?.participants).toEqual([alice.user.id]);
  });
});

describe('resetting the invite link', () => {
  async function groupWithMember(h: Harness) {
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const mallory = await h.createAccount('Mallory');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const malloryClient = await h.connectAs(mallory);
    const { roomId, first } = await createGroupWithKey(alice, aliceClient);
    await joinByInvite(bobClient, roomId, bob.user.id, first.invite.inviteToken);
    return { alice, bob, mallory, aliceClient, bobClient, malloryClient, roomId, first };
  }

  it('lets any member require a rotation that revokes the invite and hands the rotator the member proofs', async () => {
    const h = await start();
    const { alice, bob, mallory, aliceClient, bobClient, malloryClient, roomId, first } = await groupWithMember(h);
    const malloryRotations = collectEvents(malloryClient, 'e2e:rotation-required');
    const rotation = waitForEvent(aliceClient, 'e2e:rotation-required');
    const revoked = waitForEvent<InviteUpdate>(aliceClient, 'room:invite-updated');

    bobClient.emit('room:reset-invite', { roomId });

    await expect(rotation).resolves.toEqual({
      roomId,
      epoch: 2,
      memberIds: [alice.user.id, bob.user.id],
      inviteProofs: [{ userId: bob.user.id, proof: fakeProof(bob.user.id) }],
    });
    await expect(revoked).resolves.toEqual({
      roomId,
      invite: { encryptedInvite: first.invite.encryptedInvite, keyId: first.keyId, active: false },
      roster: { encryptedRoster: first.roster, keyId: first.keyId },
    });
    expect(await h.roomService.getRoomById(roomId)).toMatchObject({
      rotationRequired: 2,
      currentEpoch: 1,
      inviteTokenHash: undefined,
      encryptedInvite: first.invite.encryptedInvite,
      inviteKeyId: first.keyId,
    });
    await expectError(
      malloryClient,
      'room:join-by-invite',
      { roomId, inviteToken: first.invite.inviteToken, proof: fakeProof(mallory.user.id) },
      { code: 'room.invalidInvite', event: 'room:join-by-invite' },
    );

    const second = generation(roomId, alice.user.id, [alice.user.id, bob.user.id], { epoch: 2 });
    await publishGeneration(aliceClient, second.payload);
    await joinByInvite(malloryClient, roomId, mallory.user.id, second.invite.inviteToken);
    expect(malloryRotations).toEqual([]);
  });

  it('keeps the pending epoch when a rotation is already required', async () => {
    const h = await start();
    const { aliceClient, bobClient, roomId } = await groupWithMember(h);
    const first = waitForEvent(aliceClient, 'e2e:rotation-required');
    bobClient.emit('room:reset-invite', { roomId });
    await first;

    const second = waitForEvent<{ epoch: number }>(bobClient, 'e2e:rotation-required');
    aliceClient.emit('room:reset-invite', { roomId });
    await expect(second).resolves.toMatchObject({ epoch: 2 });
    expect(await h.roomKeyRepository.getState(roomId)).toMatchObject({ currentEpoch: 1, rotationRequired: 2 });
  });

  it('refuses a reset from a non-member with the event name and changes nothing', async () => {
    const h = await start();
    const { malloryClient, roomId, first } = await groupWithMember(h);

    await expectError(malloryClient, 'room:reset-invite', { roomId }, { code: 'room.notFound', event: 'room:reset-invite' });
    await expectError(malloryClient, 'room:reset-invite', {}, { code: 'validation.invalidPayload', event: 'room:reset-invite' });
    expect(await h.roomService.getRoomById(roomId)).toMatchObject({ inviteTokenHash: first.invite.tokenHash, rotationRequired: undefined });
  });

  it('rate limits repeated resets by the same member', async () => {
    const h = await start();
    const { bobClient, roomId } = await groupWithMember(h);
    const rotation = waitForEvent(bobClient, 'e2e:rotation-required');
    bobClient.emit('room:reset-invite', { roomId });
    await rotation;

    await expectError(bobClient, 'room:reset-invite', { roomId }, { code: 'rateLimit.inviteReset', event: 'room:reset-invite' });
  });

  it('does nothing for a group that has no key yet', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const aliceClient = await h.connectAs(alice);
    const group = await h.roomService.createGroupRoom('Amigos', alice.user.id);
    const rotations = collectEvents(aliceClient, 'e2e:rotation-required');
    const errors = collectEvents(aliceClient, 'error');

    aliceClient.emit('room:reset-invite', { roomId: group.id });
    await roundTrip(aliceClient);
    await settle(50);

    expect(rotations).toEqual([]);
    expect(errors).toEqual([]);
    expect(await h.roomKeyRepository.getState(group.id)).toEqual({ currentEpoch: 0, currentKeyId: null, rotationRequired: null });
  });
});

describe('invite updates', () => {
  it('tells only current members when a generation stores or a removal clears the invite, keeping the roster until the next batch', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const carol = await h.createAccount('Carol');
    const mallory = await h.createAccount('Mallory');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const carolClient = await h.connectAs(carol);
    const malloryClient = await h.connectAs(mallory);
    const malloryUpdates = collectEvents<InviteUpdate>(malloryClient, 'room:invite-updated');
    const created = waitForEvent<{ room: Summary }>(aliceClient, 'room:created');
    aliceClient.emit('room:create-group', { roomName: 'Amigos' });
    const roomId = (await created).room.id;

    const first = generation(roomId, alice.user.id, [alice.user.id]);
    const firstUpdate = waitForEvent<InviteUpdate>(aliceClient, 'room:invite-updated');
    aliceClient.emit('e2e:publish-room-key', first.payload);
    await expect(firstUpdate).resolves.toEqual({
      roomId,
      invite: { encryptedInvite: first.invite.encryptedInvite, keyId: first.keyId, active: true },
      roster: { encryptedRoster: first.roster, keyId: first.keyId },
    });

    await joinByInvite(bobClient, roomId, bob.user.id, first.invite.inviteToken);
    await joinByInvite(carolClient, roomId, carol.user.id, first.invite.inviteToken);
    const bobUpdates = collectEvents<InviteUpdate>(bobClient, 'room:invite-updated');

    const cleared = waitForEvent<InviteUpdate>(carolClient, 'room:invite-updated');
    const left = waitForEvent(bobClient, 'group:left');
    aliceClient.emit('group:remove-member', { roomId, userId: bob.user.id });
    await left;
    await expect(cleared).resolves.toEqual({
      roomId,
      invite: { encryptedInvite: first.invite.encryptedInvite, keyId: first.keyId, active: false },
      roster: { encryptedRoster: first.roster, keyId: first.keyId },
    });
    expect(await h.roomService.getRoomById(roomId)).toMatchObject({ encryptedRoster: first.roster, rosterKeyId: first.keyId });

    const second = generation(roomId, alice.user.id, [alice.user.id, carol.user.id], { epoch: 2 });
    const secondUpdate = waitForEvent<InviteUpdate>(carolClient, 'room:invite-updated');
    aliceClient.emit('e2e:publish-room-key', second.payload);
    await expect(secondUpdate).resolves.toEqual({
      roomId,
      invite: { encryptedInvite: second.invite.encryptedInvite, keyId: second.keyId, active: true },
      roster: { encryptedRoster: second.roster, keyId: second.keyId },
    });

    await roundTrip(bobClient);
    await roundTrip(malloryClient);
    await settle(50);
    expect(bobUpdates).toEqual([]);
    expect(malloryUpdates).toEqual([]);
  });

  it('tells the remaining members when a voluntary leave clears the invite, but not who left', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const { roomId, first } = await createGroupWithKey(alice, aliceClient);
    await joinByInvite(bobClient, roomId, bob.user.id, first.invite.inviteToken);
    const bobUpdates = collectEvents<InviteUpdate>(bobClient, 'room:invite-updated');

    const cleared = waitForEvent<InviteUpdate>(aliceClient, 'room:invite-updated');
    bobClient.emit('group:leave', { roomId });
    await expect(cleared).resolves.toEqual({
      roomId,
      invite: { encryptedInvite: first.invite.encryptedInvite, keyId: first.keyId, active: false },
      roster: { encryptedRoster: first.roster, keyId: first.keyId },
    });
    await roundTrip(bobClient);
    await settle(50);
    expect(bobUpdates).toEqual([]);
  });

  it('sends nothing for a refused reset or for a private room generation', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const mallory = await h.createAccount('Mallory');
    const aliceClient = await h.connectAs(alice);
    const malloryClient = await h.connectAs(mallory);
    const { roomId } = await createGroupWithKey(alice, aliceClient);
    const aliceUpdates = collectEvents<InviteUpdate>(aliceClient, 'room:invite-updated');

    await expectError(malloryClient, 'room:reset-invite', { roomId }, { code: 'room.notFound', event: 'room:reset-invite' });
    const privateRoom = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    await publishGeneration(aliceClient, generation(privateRoom.id, alice.user.id, [alice.user.id, bob.user.id]).payload);
    await roundTrip(aliceClient);
    await settle(50);
    expect(aliceUpdates).toEqual([]);
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
