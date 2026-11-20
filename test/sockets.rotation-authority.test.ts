import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { roomKeyReports, roomKeys, rooms } from '@/database/schema.js';
import { ROTATION_STALL_MS, rotationAuthority } from '@/modules/rooms/room.rotation-authority.js';
import type { RoomRecord } from '@/modules/rooms/room.types.js';
import { fakeEnvelope, fakeInvite, fakeName, fakeRoster, newKeyId } from './support/room-keys.js';
import { fakeProof, seedInvite } from './support/invites.js';
import { collectEvents, roundTrip, settle, startSocketHarness, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

interface Rejection {
  code: string;
  retryAfterMs?: number;
  rotationRequiredEpoch: number | null;
  currentEpoch: number;
}

interface Delivery {
  keyId: string;
  epoch: number;
  senderId: string;
  sealedKey: string;
}

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function createGroup(client: TestClient): Promise<string> {
  const created = waitForEvent<{ room: { id: string } }>(client, 'room:created');
  client.emit('room:create-group', {});
  return (await created).room.id;
}

async function join(client: TestClient, roomId: string, userId: string, inviteToken: string): Promise<void> {
  const joined = waitForEvent(client, 'room:joined');
  client.emit('room:join-by-invite', { roomId, inviteToken, proof: fakeProof(userId) });
  await joined;
}

function batch(roomId: string, senderId: string, recipients: string[], epoch = 1, keyId = newKeyId()) {
  return {
    roomId,
    keyId,
    epoch,
    keys: recipients.map((userId) => ({ userId, sealedKey: fakeEnvelope({ roomId, keyId, epoch, senderId, recipientId: userId }) })),
    invite: { tokenHash: fakeInvite(keyId).tokenHash, encryptedInvite: fakeInvite(keyId).encryptedInvite },
    roster: fakeRoster(keyId),
    name: fakeName(keyId),
  };
}

async function groupWithGeneration() {
  const h = (harness = await startSocketHarness());
  const alice = await h.createAccount('Alice');
  const bob = await h.createAccount('Bob');
  const carol = await h.createAccount('Carol');
  const aliceClient = await h.connectAs(alice);
  const bobClient = await h.connectAs(bob);
  const carolClient = await h.connectAs(carol);
  const roomId = await createGroup(aliceClient);
  const { inviteToken } = await seedInvite(h.db, roomId);
  await join(bobClient, roomId, bob.user.id, inviteToken);
  await join(carolClient, roomId, carol.user.id, inviteToken);
  const members = [alice.user.id, bob.user.id, carol.user.id];
  const first = batch(roomId, alice.user.id, members);
  const delivered = waitForEvent(aliceClient, 'e2e:room-key');
  aliceClient.emit('e2e:publish-room-key', first);
  await delivered;
  return { h, alice, bob, carol, aliceClient, bobClient, carolClient, roomId, members, first };
}

describe('rotationAuthority', () => {
  const room = (overrides: Partial<RoomRecord>): RoomRecord => ({
    id: 'r',
    type: 'group',
    participants: ['a', 'b'],
    admins: ['a'],
    createdAt: '2026-01-01T00:00:00.000Z',
    visibleTo: [],
    blockedBy: {},
    deletedAt: {},
    ...overrides,
  });
  const started = '2026-01-01T00:00:00.000Z';
  const at = Date.parse(started);

  it('leaves private rooms and the first generation unrestricted', () => {
    expect(rotationAuthority(room({ type: 'private', admins: [] }), 'b', 5, at).authority).toBe('unrestricted');
    expect(rotationAuthority(room({}), 'b', 1, at).authority).toBe('initial');
  });

  it('lets admins rotate immediately and members only after the stall window', () => {
    const stalled = room({ rotationRequiredAt: started });
    expect(rotationAuthority(stalled, 'a', 2, at).authority).toBe('admin');
    expect(rotationAuthority(stalled, 'b', 2, at + 1000)).toEqual({ authority: null, retryAfterMs: ROTATION_STALL_MS - 1000 });
    expect(rotationAuthority(stalled, 'b', 2, at + ROTATION_STALL_MS).authority).toBe('stalled');
  });

  it('lets any member rotate a room that has no admin left or whose rotation predates the timestamp column', () => {
    expect(rotationAuthority(room({ admins: [] }), 'b', 2, at).authority).toBe('adminless');
    expect(rotationAuthority(room({}), 'b', 2, at).authority).toBe('stalled');
  });
});

describe('rotation authority over sockets', () => {
  it('rejects a non-admin rotation while an admin can still act and leaves the room state untouched', async () => {
    const { h, alice, bob, carol, aliceClient, bobClient, roomId, first } = await groupWithGeneration();
    const notices = collectEvents(bobClient, 'e2e:rotation-required');
    const carolClient = await h.connectAs(carol);
    carolClient.emit('group:leave', { roomId });
    await settle(200);
    expect(notices.length).toBeGreaterThan(0);

    const rejected = waitForEvent<Rejection>(bobClient, 'e2e:room-key-rejected');
    bobClient.emit('e2e:publish-room-key', batch(roomId, bob.user.id, [alice.user.id, bob.user.id], 2));

    const rejection = await rejected;
    expect(rejection.code).toBe('e2e.rotationNotAuthorized');
    expect(rejection.retryAfterMs).toBeGreaterThan(0);
    expect(rejection.retryAfterMs).toBeLessThanOrEqual(ROTATION_STALL_MS);
    expect(await h.roomKeyRepository.getState(roomId)).toMatchObject({ currentEpoch: 1, currentKeyId: first.keyId, rotationRequired: 2 });

    const accepted = waitForEvent<Delivery>(bobClient, 'e2e:room-key');
    const rotation = batch(roomId, alice.user.id, [alice.user.id, bob.user.id], 2);
    aliceClient.emit('e2e:publish-room-key', rotation);
    await expect(accepted).resolves.toMatchObject({ keyId: rotation.keyId, senderId: alice.user.id });
  });

  it('lets a non-admin member retry once the rotation has stalled', async () => {
    const { h, alice, bob, carol, bobClient, roomId } = await groupWithGeneration();
    const carolClient = await h.connectAs(carol);
    carolClient.emit('group:leave', { roomId });
    await settle(200);

    await h.db.update(rooms).set({ rotationRequiredAt: new Date(Date.now() - ROTATION_STALL_MS - 1000).toISOString() }).where(eq(rooms.id, roomId));
    const rotation = batch(roomId, bob.user.id, [alice.user.id, bob.user.id], 2);
    const accepted = waitForEvent<Delivery>(bobClient, 'e2e:room-key');
    bobClient.emit('e2e:publish-room-key', rotation);

    await expect(accepted).resolves.toMatchObject({ keyId: rotation.keyId, epoch: 2 });
    expect(await h.roomKeyRepository.getState(roomId)).toMatchObject({ currentEpoch: 2, rotationRequired: null });
    const [row] = await h.db.select({ at: rooms.rotationRequiredAt }).from(rooms).where(eq(rooms.id, roomId));
    expect(row?.at).toBeNull();
  });

  it('lets a member rotate a group whose last admin has left', async () => {
    const { h, bob, carol, roomId, aliceClient, bobClient } = await groupWithGeneration();
    const notice = waitForEvent(bobClient, 'e2e:rotation-required');
    aliceClient.emit('group:leave', { roomId });
    await notice;

    const rotation = batch(roomId, bob.user.id, [bob.user.id, carol.user.id], 2);
    const accepted = waitForEvent<Delivery>(bobClient, 'e2e:room-key');
    bobClient.emit('e2e:publish-room-key', rotation);

    await expect(accepted).resolves.toMatchObject({ epoch: 2, senderId: bob.user.id });
    expect((await h.roomService.getRoomById(roomId))?.admins).toEqual([]);
  });

  it('records when a rotation was requested and clears it once the new generation lands', async () => {
    const { h, alice, bob, carol, roomId, aliceClient } = await groupWithGeneration();
    const adminClient = aliceClient;
    const requested = waitForEvent(adminClient, 'e2e:rotation-required');
    adminClient.emit('room:reset-invite', { roomId });
    await requested;
    const [pending] = await h.db.select({ at: rooms.rotationRequiredAt, required: rooms.rotationRequired }).from(rooms).where(eq(rooms.id, roomId));
    expect(pending?.required).toBe(2);
    expect(Date.parse(pending?.at ?? '')).not.toBeNaN();

    const accepted = waitForEvent(adminClient, 'e2e:room-key');
    adminClient.emit('e2e:publish-room-key', batch(roomId, alice.user.id, [alice.user.id, bob.user.id, carol.user.id], 2));
    await accepted;
    const [cleared] = await h.db.select({ at: rooms.rotationRequiredAt }).from(rooms).where(eq(rooms.id, roomId));
    expect(cleared?.at).toBeNull();
  });
});

describe('reporting an unusable room key', () => {
  it('drops only the reporter envelope, asks the room for a replacement and bars the poisoner from re-sending it', async () => {
    const { h, alice, bob, carol, aliceClient, bobClient, carolClient, roomId, first } = await groupWithGeneration();
    const requests = collectEvents<{ requesterId: string }>(carolClient, 'e2e:key-request');

    bobClient.emit('e2e:report-bad-key', { roomId, keyId: first.keyId });
    await settle(250);

    const reports = await h.db.select().from(roomKeyReports).where(eq(roomKeyReports.roomId, roomId));
    expect(reports).toMatchObject([{ userId: bob.user.id, keyId: first.keyId, senderId: alice.user.id }]);
    const remaining = await h.db.select({ userId: roomKeys.userId }).from(roomKeys).where(eq(roomKeys.roomId, roomId));
    expect(remaining.map((row) => row.userId).sort()).toEqual([alice.user.id, carol.user.id].sort());
    expect(requests.map((request) => request.requesterId)).toEqual([bob.user.id]);
    expect(await h.roomKeyRepository.getState(roomId)).toMatchObject({ rotationRequired: null });

    const barred = waitForEvent<Rejection>(aliceClient, 'e2e:room-key-rejected', (event) => event.code === 'e2e.roomKeyConflict');
    aliceClient.emit('e2e:share-room-key', {
      roomId,
      keyId: first.keyId,
      epoch: 1,
      keys: [{ userId: bob.user.id, sealedKey: fakeEnvelope({ roomId, keyId: first.keyId, epoch: 1, senderId: alice.user.id, recipientId: bob.user.id }) }],
    });
    await expect(barred).resolves.toMatchObject({ code: 'e2e.roomKeyConflict' });

    const replacement = fakeEnvelope({ roomId, keyId: first.keyId, epoch: 1, senderId: carol.user.id, recipientId: bob.user.id });
    const delivered = waitForEvent<Delivery>(bobClient, 'e2e:room-key');
    carolClient.emit('e2e:share-room-key', { roomId, keyId: first.keyId, epoch: 1, keys: [{ userId: bob.user.id, sealedKey: replacement }] });
    await expect(delivered).resolves.toMatchObject({ senderId: carol.user.id, sealedKey: replacement });
  });

  it('reopens the rotation once enough members report the current generation', async () => {
    const { h, roomId, bobClient, carolClient, aliceClient, first } = await groupWithGeneration();
    const notice = waitForEvent<{ epoch: number }>(aliceClient, 'e2e:rotation-required');

    bobClient.emit('e2e:report-bad-key', { roomId, keyId: first.keyId });
    await settle(150);
    carolClient.emit('e2e:report-bad-key', { roomId, keyId: first.keyId });

    await expect(notice).resolves.toMatchObject({ epoch: 2 });
    expect(await h.roomKeyRepository.getState(roomId)).toMatchObject({ currentEpoch: 1, rotationRequired: 2 });
  });

  it('ignores a sender reporting its own envelope and strangers', async () => {
    const { h, aliceClient, roomId, first } = await groupWithGeneration();
    const stranger = await h.createAccount('Mallory');
    const strangerClient = await h.connectAs(stranger);

    aliceClient.emit('e2e:report-bad-key', { roomId, keyId: first.keyId });
    strangerClient.emit('e2e:report-bad-key', { roomId, keyId: first.keyId });
    await roundTrip(aliceClient);
    await roundTrip(strangerClient);

    expect(await h.db.select().from(roomKeyReports)).toHaveLength(0);
    expect(await h.db.select().from(roomKeys).where(eq(roomKeys.roomId, roomId))).toHaveLength(3);
  });
});
