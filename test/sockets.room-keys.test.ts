import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeEnvelope, fakeInvite, fakeName, fakeRoster, newKeyId } from './support/room-keys.js';
import { fakeProof, seedInvite } from './support/invites.js';
import { collectEvents, roundTrip, settle, startSocketHarness, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

interface Delivery {
  roomId: string;
  keyId: string;
  epoch: number;
  senderId: string;
  sealedKey: string;
}

interface Rejection {
  roomId: string;
  keyId: string;
  epoch: number;
  currentEpoch: number;
  currentKeyId: string | null;
  rotationRequiredEpoch: number | null;
  event: string;
  code: string;
  message: string;
}

interface RoomSummaryPayload {
  id: string;
  currentEpoch: number;
  currentKeyId: string | null;
  rotationRequiredEpoch: number | null;
}

let harness: Harness | null = null;

async function start(): Promise<Harness> {
  harness = await startSocketHarness();
  return harness;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

async function createGroup(client: TestClient, roomName: string): Promise<{ id: string }> {
  const created = waitForEvent<{ room: RoomSummaryPayload }>(client, 'room:created');
  client.emit('room:create-group', { roomName });
  const { room } = await created;
  return { id: room.id };
}

async function joinByInvite(client: TestClient, roomId: string, userId: string, inviteToken: string): Promise<void> {
  const joined = waitForEvent(client, 'room:joined');
  client.emit('room:join-by-invite', { roomId, inviteToken, proof: fakeProof(userId) });
  await joined;
}

async function listRooms(client: TestClient): Promise<RoomSummaryPayload[]> {
  const listed = waitForEvent<{ rooms: RoomSummaryPayload[] }>(client, 'rooms:list');
  client.emit('rooms:get');
  return (await listed).rooms;
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

async function groupOfThree(h: Harness) {
  const alice = await h.createAccount('Alice');
  const bob = await h.createAccount('Bob');
  const carol = await h.createAccount('Carol');
  const aliceClient = await h.connectAs(alice);
  const bobClient = await h.connectAs(bob);
  const carolClient = await h.connectAs(carol);
  const group = await createGroup(aliceClient, 'Amigos');
  const { inviteToken } = await seedInvite(h.db, group.id);
  await joinByInvite(bobClient, group.id, bob.user.id, inviteToken);
  await joinByInvite(carolClient, group.id, carol.user.id, inviteToken);
  return { alice, bob, carol, aliceClient, bobClient, carolClient, group, members: [alice.user.id, bob.user.id, carol.user.id] };
}

describe('publishing a room key generation', () => {
  it('stores the first complete batch, acknowledges it and gives each member only their own envelope', async () => {
    const h = await start();
    const { alice, bob, aliceClient, bobClient, carolClient, group, members } = await groupOfThree(h);
    const published = batch(group.id, alice.user.id, members);
    const bobDeliveries = collectEvents<Delivery>(bobClient, 'e2e:room-key');
    const carolDeliveries = collectEvents<Delivery>(carolClient, 'e2e:room-key');

    const ownEnvelope = waitForEvent<Delivery>(aliceClient, 'e2e:room-key');
    aliceClient.emit('e2e:publish-room-key', published);

    await expect(ownEnvelope).resolves.toEqual({
      roomId: group.id,
      keyId: published.keyId,
      epoch: 1,
      senderId: alice.user.id,
      sealedKey: published.keys[0]?.sealedKey,
      roster: published.roster,
    });
    await roundTrip(bobClient);
    await roundTrip(carolClient);
    await settle(50);
    expect(bobDeliveries).toEqual([
      { roomId: group.id, keyId: published.keyId, epoch: 1, senderId: alice.user.id, sealedKey: published.keys[1]?.sealedKey, roster: published.roster },
    ]);
    expect(carolDeliveries.map((delivery) => delivery.sealedKey)).toEqual([published.keys[2]?.sealedKey]);
    expect(await h.roomKeyRepository.getState(group.id)).toEqual({ currentEpoch: 1, currentKeyId: published.keyId, rotationRequired: null });

    const summaries = await listRooms(bobClient);
    expect(summaries.find((room) => room.id === group.id)).toMatchObject({ currentEpoch: 1, currentKeyId: published.keyId, rotationRequiredEpoch: null });
    expect(bob.user.id).toBe(members[1]);
  });

  it('rejects a later batch for the same epoch with a translated error and the winning key id', async () => {
    const h = await start();
    const { alice, bob, aliceClient, bobClient, group, members } = await groupOfThree(h);
    const first = batch(group.id, alice.user.id, members);
    const won = waitForEvent(aliceClient, 'e2e:room-key');
    aliceClient.emit('e2e:publish-room-key', first);
    await won;

    const errors = collectEvents(bobClient, 'error');
    const rejected = waitForEvent<Rejection>(bobClient, 'e2e:room-key-rejected');
    const second = batch(group.id, bob.user.id, members);
    bobClient.emit('e2e:publish-room-key', second);

    const rejection = await rejected;
    expect(rejection).toMatchObject({
      roomId: group.id,
      keyId: second.keyId,
      epoch: 1,
      currentEpoch: 1,
      currentKeyId: first.keyId,
      rotationRequiredEpoch: null,
      code: 'e2e.roomKeyStale',
    });
    expect(rejection.message.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(0);
    expect((await h.roomKeyRepository.findForParticipantInRooms([group.id], alice.user.id)).map((key) => key.keyId)).toEqual([first.keyId]);
  });

  it('rejects a batch that does not cover every current member, or covers someone else', async () => {
    const h = await start();
    const { alice, carol, aliceClient, group, members } = await groupOfThree(h);
    const outsider = await h.createAccount('Mallory');
    const missing = waitForEvent<Rejection>(aliceClient, 'e2e:room-key-rejected');
    aliceClient.emit('e2e:publish-room-key', batch(group.id, alice.user.id, members.filter((id) => id !== carol.user.id)));
    await expect(missing).resolves.toMatchObject({ code: 'e2e.roomKeyIncomplete' });

    const extra = waitForEvent<Rejection>(aliceClient, 'e2e:room-key-rejected');
    aliceClient.emit('e2e:publish-room-key', batch(group.id, alice.user.id, [...members, outsider.user.id]));
    await expect(extra).resolves.toMatchObject({ code: 'e2e.roomKeyIncomplete' });
    expect(await h.roomKeyRepository.getState(group.id)).toMatchObject({ currentEpoch: 0 });
  });

  it('refuses envelopes whose header does not match the batch, the sender or the recipient', async () => {
    const h = await start();
    const { alice, bob, carol, aliceClient, group, members } = await groupOfThree(h);
    const keyId = newKeyId();
    const envelope = (overrides: Partial<{ roomId: string; keyId: string; epoch: number; senderId: string; recipientId: string }>) =>
      fakeEnvelope({ roomId: group.id, keyId, epoch: 1, senderId: alice.user.id, recipientId: carol.user.id, ...overrides });
    const forged = [
      envelope({ roomId: 'other-room' }),
      envelope({ keyId: newKeyId() }),
      envelope({ epoch: 2 }),
      envelope({ senderId: bob.user.id }),
      envelope({ recipientId: bob.user.id }),
      'not json',
      JSON.stringify({ ...JSON.parse(envelope({})), v: 1 }),
      JSON.stringify({ ...JSON.parse(envelope({})), extra: true }),
      JSON.stringify({ ...JSON.parse(envelope({})), box: 'short' }),
    ];
    for (const sealedKey of forged) {
      const valid = batch(group.id, alice.user.id, members, 1, keyId);
      const error = waitForEvent<Rejection>(aliceClient, 'e2e:room-key-rejected');
      aliceClient.emit('e2e:publish-room-key', {
        ...valid,
        keys: valid.keys.map((key) => (key.userId === carol.user.id ? { userId: key.userId, sealedKey } : key)),
      });
      await expect(error).resolves.toEqual(expect.objectContaining({ code: 'e2e.invalidRoomKeyEnvelope', event: 'e2e:publish-room-key' }));
    }

    expect(await h.roomKeyRepository.getState(group.id)).toMatchObject({ currentEpoch: 0 });
  });

  it('ignores a batch from someone who is not a member', async () => {
    const h = await start();
    const { members, group } = await groupOfThree(h);
    const mallory = await h.createAccount('Mallory');
    const malloryClient = await h.connectAs(mallory);
    const acks = [...['e2e:room-key', 'e2e:room-key-rejected', 'error'].map((event) => collectEvents(malloryClient, event))];

    malloryClient.emit('e2e:publish-room-key', batch(group.id, mallory.user.id, members));
    await roundTrip(malloryClient);
    await settle(50);

    expect(acks.flat()).toHaveLength(0);
    expect(await h.roomKeyRepository.getState(group.id)).toMatchObject({ currentEpoch: 0 });
  });
});

describe('room key rotation', () => {
  async function groupWithGeneration(h: Harness) {
    const context = await groupOfThree(h);
    const first = batch(context.group.id, context.alice.user.id, context.members);
    const ownEnvelope = waitForEvent(context.aliceClient, 'e2e:room-key');
    context.aliceClient.emit('e2e:publish-room-key', first);
    await ownEnvelope;
    return { ...context, first };
  }

  it('requires a rotation when a member leaves and accepts only the next epoch for the remaining members', async () => {
    const h = await start();
    const { alice, bob, carol, aliceClient, bobClient, carolClient, group } = await groupWithGeneration(h);

    const notices = Promise.all([aliceClient, bobClient].map((client) => waitForEvent(client, 'e2e:rotation-required')));
    const carolNotices = collectEvents(carolClient, 'e2e:rotation-required');
    carolClient.emit('group:leave', { roomId: group.id });

    const memberIds = [alice.user.id, bob.user.id];
    expect(await notices).toEqual([
      { roomId: group.id, epoch: 2, memberIds, inviteProofs: [{ userId: bob.user.id, proof: fakeProof(bob.user.id) }] },
      { roomId: group.id, epoch: 2, memberIds, inviteProofs: [{ userId: bob.user.id, proof: fakeProof(bob.user.id) }] },
    ]);
    expect(carolNotices).toHaveLength(0);
    expect((await listRooms(bobClient)).find((room) => room.id === group.id)).toMatchObject({ currentEpoch: 1, rotationRequiredEpoch: 2 });

    const stillWithCarol = waitForEvent<Rejection>(aliceClient, 'e2e:room-key-rejected');
    aliceClient.emit('e2e:publish-room-key', batch(group.id, alice.user.id, [alice.user.id, bob.user.id, carol.user.id], 2));
    await expect(stillWithCarol).resolves.toMatchObject({ code: 'e2e.roomKeyIncomplete', rotationRequiredEpoch: 2, event: 'e2e:publish-room-key' });

    const rotation = batch(group.id, alice.user.id, [alice.user.id, bob.user.id], 2);
    const toBob = waitForEvent<Delivery>(bobClient, 'e2e:room-key');
    const toAlice = waitForEvent<Delivery>(aliceClient, 'e2e:room-key');
    aliceClient.emit('e2e:publish-room-key', rotation);
    await expect(toBob).resolves.toMatchObject({ keyId: rotation.keyId, sealedKey: rotation.keys[1]?.sealedKey });

    await expect(toAlice).resolves.toMatchObject({ keyId: rotation.keyId, epoch: 2, senderId: alice.user.id });
    expect(await h.roomKeyRepository.getState(group.id)).toEqual({ currentEpoch: 2, currentKeyId: rotation.keyId, rotationRequired: null });
  });

  it('requires a rotation when an admin removes a member', async () => {
    const h = await start();
    const { alice, bob, carol, aliceClient, bobClient, group } = await groupWithGeneration(h);

    const notice = waitForEvent(bobClient, 'e2e:rotation-required');
    aliceClient.emit('group:remove-member', { roomId: group.id, userId: carol.user.id });

    await expect(notice).resolves.toEqual({
      roomId: group.id,
      epoch: 2,
      memberIds: [alice.user.id, bob.user.id],
      inviteProofs: [{ userId: bob.user.id, proof: fakeProof(bob.user.id) }],
    });
    expect(await h.roomKeyRepository.getState(group.id)).toMatchObject({ currentEpoch: 1, rotationRequired: 2 });
  });

  it('still requires and announces the rotation when the removal notice fails afterwards', async () => {
    const h = await start();
    const { alice, bob, carol, aliceClient, bobClient, group } = await groupWithGeneration(h);
    vi.spyOn(h.messageService, 'createSystemMessage').mockRejectedValue(new Error('db down'));

    const notice = waitForEvent(bobClient, 'e2e:rotation-required');
    aliceClient.emit('group:remove-member', { roomId: group.id, userId: carol.user.id });

    await expect(notice).resolves.toEqual({
      roomId: group.id,
      epoch: 2,
      memberIds: [alice.user.id, bob.user.id],
      inviteProofs: [{ userId: bob.user.id, proof: fakeProof(bob.user.id) }],
    });
    expect(await h.roomKeyRepository.getState(group.id)).toMatchObject({ rotationRequired: 2 });
  });

  it('announces the rotation to who stays even when the removed user record is gone', async () => {
    const h = await start();
    const { carol, aliceClient, bobClient, group } = await groupWithGeneration(h);
    vi.spyOn(h.userService, 'getUser').mockResolvedValue(null);

    const notice = waitForEvent(bobClient, 'e2e:rotation-required');
    aliceClient.emit('group:remove-member', { roomId: group.id, userId: carol.user.id });

    await expect(notice).resolves.toMatchObject({ roomId: group.id, epoch: 2 });
    expect(carol.user.id).toBeDefined();
  });

  it('requires a rotation in every room of a member whose identity key changes on the server', async () => {
    const h = await start();
    const { alice, bob, aliceClient, bobClient, group } = await groupWithGeneration(h);
    const privateRoom = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    await h.establishRoomKey(privateRoom.id);
    const untouched = await h.roomService.createGroupRoom(alice.user.id);
    await h.establishRoomKey(untouched.id);
    await h.userService.publishE2eKeys(bob.user.id, { publicKey: 'bob-first-key' });
    await listRooms(aliceClient);
    expect(bobClient.connected).toBe(true);

    const notices = await h.userRepository.updateIdentityRequiringRotation(bob.user.id, { e2ePublicKey: 'bob-second-key' });

    expect(notices.map((notice) => notice.roomId).sort()).toEqual([group.id, privateRoom.id].sort());
    expect(await h.roomKeyRepository.getState(privateRoom.id)).toMatchObject({ rotationRequired: 2 });
    expect(await h.roomKeyRepository.getState(untouched.id)).toMatchObject({ rotationRequired: null });
  });

  it('refuses a second identity key publish without requiring a rotation', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    await h.userService.publishE2eKeys(bob.user.id, { publicKey: 'bob-key' });
    await h.establishRoomKey(room.id);

    await expect(h.userService.publishE2eKeys(bob.user.id, { publicKey: 'bob-other-key' })).rejects.toMatchObject({ code: 'e2e.keysLocked' });
    expect(await h.roomKeyRepository.getState(room.id)).toMatchObject({ rotationRequired: null });
  });

  it('lets exactly one of two members racing to rotate win and tells the other the winning key', async () => {
    const h = await start();
    const { alice, bob, carol, aliceClient, bobClient, carolClient, group } = await groupWithGeneration(h);
    const left = waitForEvent(aliceClient, 'e2e:rotation-required');
    carolClient.emit('group:leave', { roomId: group.id });
    await left;
    const remaining = [alice.user.id, bob.user.id];
    const outcomes = [
      { client: aliceClient, userId: alice.user.id },
      { client: bobClient, userId: bob.user.id },
    ].map(({ client, userId }) =>
      Promise.race([
        waitForEvent<Delivery>(client, 'e2e:room-key', (event) => event.senderId === userId && event.epoch === 2).then((event) => ({
          won: true,
          keyId: event.keyId,
        })),
        waitForEvent<Rejection>(client, 'e2e:room-key-rejected').then((event) => ({ won: false, keyId: event.currentKeyId })),
      ]),
    );

    aliceClient.emit('e2e:publish-room-key', batch(group.id, alice.user.id, remaining, 2));
    bobClient.emit('e2e:publish-room-key', batch(group.id, bob.user.id, remaining, 2));
    const results = await Promise.all(outcomes);

    expect(results.filter((result) => result.won)).toHaveLength(1);
    expect(new Set(results.map((result) => result.keyId)).size).toBe(1);
    expect((await h.roomKeyRepository.getState(group.id))?.currentKeyId).toBe(results[0]?.keyId);
    expect(carol.user.id).not.toBe(alice.user.id);
  });

  it('does not rotate when a member joins, and lets a holder share the current generation with them', async () => {
    const h = await start();
    const { bob, bobClient, group, first } = await groupWithGeneration(h);
    const dave = await h.createAccount('Dave');
    const daveClient = await h.connectAs(dave);
    const rotations = collectEvents(bobClient, 'e2e:rotation-required');
    const joinRequest = waitForEvent(bobClient, 'e2e:key-request');

    await joinByInvite(daveClient, group.id, dave.user.id, fakeInvite(first.keyId).inviteToken);
    await expect(joinRequest).resolves.toEqual({ roomId: group.id, requesterId: dave.user.id, proof: fakeProof(dave.user.id) });
    await settle(50);
    expect(rotations).toHaveLength(0);
    expect(await h.roomKeyRepository.getState(group.id)).toMatchObject({ currentEpoch: 1, rotationRequired: null });

    const requested = waitForEvent(bobClient, 'e2e:key-request');
    daveClient.emit('e2e:request-room-key', { roomId: group.id });
    await expect(requested).resolves.toEqual({ roomId: group.id, requesterId: dave.user.id, proof: fakeProof(dave.user.id) });

    const asGeneration = waitForEvent<Rejection>(bobClient, 'e2e:room-key-rejected');
    bobClient.emit('e2e:publish-room-key', batch(group.id, bob.user.id, [dave.user.id], 1, first.keyId));
    await expect(asGeneration).resolves.toMatchObject({ code: 'e2e.roomKeyStale', event: 'e2e:publish-room-key' });

    const delivered = waitForEvent<Delivery>(daveClient, 'e2e:room-key');
    bobClient.emit('e2e:share-room-key', batch(group.id, bob.user.id, [dave.user.id], 1, first.keyId));
    await expect(delivered).resolves.toMatchObject({ keyId: first.keyId, epoch: 1, senderId: bob.user.id });

    const replaced = waitForEvent<Rejection>(bobClient, 'e2e:room-key-rejected');
    bobClient.emit('e2e:share-room-key', batch(group.id, bob.user.id, [dave.user.id], 1, first.keyId));
    await expect(replaced).resolves.toMatchObject({ code: 'e2e.roomKeyConflict', event: 'e2e:share-room-key' });

    const nextEpoch = waitForEvent<Rejection>(bobClient, 'e2e:room-key-rejected');
    bobClient.emit('e2e:share-room-key', batch(group.id, bob.user.id, [dave.user.id], 2));
    await expect(nextEpoch).resolves.toMatchObject({ code: 'e2e.roomKeyStale', event: 'e2e:share-room-key' });
  });

  it('returns every generation a member holds, oldest first', async () => {
    const h = await start();
    const { alice, bob, carol, aliceClient, bobClient, carolClient, group, first } = await groupWithGeneration(h);
    const left = waitForEvent(aliceClient, 'e2e:rotation-required');
    carolClient.emit('group:leave', { roomId: group.id });
    await left;
    const rotation = batch(group.id, alice.user.id, [alice.user.id, bob.user.id], 2);
    const ownEnvelope = waitForEvent<Delivery>(aliceClient, 'e2e:room-key', (event) => event.epoch === 2);
    aliceClient.emit('e2e:publish-room-key', rotation);
    await ownEnvelope;

    const listed = waitForEvent<{ keys: Delivery[] }>(bobClient, 'e2e:room-keys');
    bobClient.emit('e2e:get-room-keys', { roomIds: [group.id] });

    expect((await listed).keys.map((key) => [key.keyId, key.epoch, key.senderId])).toEqual([
      [first.keyId, 1, alice.user.id],
      [rotation.keyId, 2, alice.user.id],
    ]);
    expect(carol.user.id).toBeDefined();
  });

  it('forwards at most one key request per user and room every thirty seconds', async () => {
    const h = await start();
    const { aliceClient, bobClient, group } = await groupOfThree(h);
    const requests = collectEvents(aliceClient, 'e2e:key-request');

    bobClient.emit('e2e:request-room-key', { roomId: group.id });
    bobClient.emit('e2e:request-room-key', { roomId: group.id });
    bobClient.emit('e2e:request-room-key', { roomId: group.id });
    await roundTrip(bobClient);
    await settle(100);

    expect(requests).toHaveLength(1);
  });
});
