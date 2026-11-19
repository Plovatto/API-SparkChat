import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { roomRosters, rooms } from '@/database/schema.js';
import { fakeProof, seedInvite } from './support/invites.js';
import { fakeEnvelope, fakeInvite, fakeName, fakeRoster, newKeyId } from './support/room-keys.js';
import { collectEvents, roundTrip, settle, startSocketHarness, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;
type Account = Awaited<ReturnType<Harness['createAccount']>>;

interface Delivery {
  roomId: string;
  keyId: string;
  epoch: number;
  senderId: string;
  sealedKey: string;
  roster?: string;
}

interface NameUpdate {
  roomId: string;
  encryptedName: string;
  keyId: string;
}

interface Summary {
  id: string;
  encryptedName: { encryptedName: string; keyId: string } | null;
  roster: { encryptedRoster: string; keyId: string } | null;
}

interface ErrorEvent {
  code: string;
  event?: string;
  params?: Record<string, unknown>;
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

interface GenerationOptions {
  epoch?: number;
  keyId?: string;
  name?: string | null;
  roster?: string;
}

function generation(roomId: string, senderId: string, recipients: string[], options: GenerationOptions = {}) {
  const { epoch = 1, keyId = newKeyId() } = options;
  const name = options.name === undefined ? fakeName(keyId) : options.name;
  const roster = options.roster ?? fakeRoster(keyId);
  const invite = fakeInvite(keyId);
  return {
    roomId,
    keyId,
    epoch,
    keys: recipients.map((userId) => ({ userId, sealedKey: fakeEnvelope({ roomId, keyId, epoch, senderId, recipientId: userId }) })),
    invite: { tokenHash: invite.tokenHash, encryptedInvite: invite.encryptedInvite },
    roster,
    ...(name === null ? {} : { name }),
  };
}

async function createGroup(client: TestClient, payload: unknown = {}): Promise<{ id: string }> {
  const created = waitForEvent<{ room: Summary }>(client, 'room:created');
  client.emit('room:create-group', payload);
  const { room } = await created;
  return { id: room.id };
}

async function publish(client: TestClient, payload: ReturnType<typeof generation>): Promise<void> {
  const stored = waitForEvent(client, 'e2e:room-key');
  client.emit('e2e:publish-room-key', payload);
  await stored;
}

async function publishToMembers(clients: TestClient[], payload: ReturnType<typeof generation>): Promise<void> {
  const [publisher] = clients;
  if (!publisher) {
    throw new Error('publisher missing');
  }
  const names = clients.map((client) => waitForEvent(client, 'room:name-updated'));
  await publish(publisher, payload);
  await Promise.all(names);
}

async function summaryOf(client: TestClient, roomId: string): Promise<Summary | undefined> {
  const listed = waitForEvent<{ rooms: Summary[] }>(client, 'rooms:list');
  client.emit('rooms:get');
  return (await listed).rooms.find((room) => room.id === roomId);
}

async function getRoomKeys(client: TestClient, payload: unknown): Promise<Delivery[]> {
  const listed = waitForEvent<{ keys: Delivery[] }>(client, 'e2e:room-keys');
  client.emit('e2e:get-room-keys', payload);
  return (await listed).keys;
}

async function expectError(client: TestClient, event: string, payload: unknown, expected: ErrorEvent): Promise<void> {
  const error = waitForEvent<ErrorEvent>(client, 'error');
  client.emit(event, payload);
  await expect(error).resolves.toMatchObject(expected);
}

async function groupOfTwo(h: Harness) {
  const alice = await h.createAccount('Alice');
  const bob = await h.createAccount('Bob');
  const aliceClient = await h.connectAs(alice);
  const bobClient = await h.connectAs(bob);
  const group = await createGroup(aliceClient);
  const { inviteToken } = await seedInvite(h.db, group.id);
  const joined = waitForEvent(bobClient, 'room:joined');
  bobClient.emit('room:join-by-invite', { roomId: group.id, inviteToken, proof: fakeProof(bob.user.id) });
  await joined;
  return { alice, bob, aliceClient, bobClient, group, members: [alice.user.id, bob.user.id] };
}

async function rotate(h: Harness, client: TestClient, sender: Account, roomId: string, members: string[], epoch: number, keyId = newKeyId()) {
  await h.roomKeyRepository.markRotationRequired(roomId);
  const payload = generation(roomId, sender.user.id, members, { epoch, keyId });
  await publish(client, payload);
  return payload;
}

async function storedRoom(h: Harness, roomId: string) {
  const [row] = await h.db
    .select({ name: rooms.name, encryptedName: rooms.encryptedName, nameKeyId: rooms.nameKeyId })
    .from(rooms)
    .where(eq(rooms.id, roomId));
  return row;
}

async function storedRosters(h: Harness, roomId: string) {
  const rows = await h.db
    .select({ keyId: roomRosters.keyId, encryptedRoster: roomRosters.encryptedRoster })
    .from(roomRosters)
    .where(eq(roomRosters.roomId, roomId));
  return rows.sort((a, b) => a.keyId.localeCompare(b.keyId));
}

describe('encrypted group name', () => {
  it('never stores or returns a plaintext group name, even when an old client sends one', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const aliceClient = await h.connectAs(alice);
    const created = waitForEvent<{ room: Summary; messages: unknown[] }>(aliceClient, 'room:created');
    aliceClient.emit('room:create-group', { roomName: 'Clube secreto' });
    const { room, messages } = await created;

    expect(await storedRoom(h, room.id)).toEqual({ name: null, encryptedName: null, nameKeyId: null });
    expect(room).not.toHaveProperty('name');
    expect(room.encryptedName).toBeNull();
    expect(JSON.stringify({ room, messages })).not.toContain('Clube secreto');
  });

  it('refuses a group generation without a name and stores nothing', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const aliceClient = await h.connectAs(alice);
    const group = await createGroup(aliceClient);

    const rejected = waitForEvent<ErrorEvent>(aliceClient, 'e2e:room-key-rejected');
    aliceClient.emit('e2e:publish-room-key', generation(group.id, alice.user.id, [alice.user.id], { name: null }));
    await expect(rejected).resolves.toMatchObject({ code: 'e2e.nameRequired', event: 'e2e:publish-room-key' });

    expect(await h.roomKeyRepository.getState(group.id)).toEqual({ currentEpoch: 0, currentKeyId: null, rotationRequired: null });
    expect(await storedRosters(h, group.id)).toEqual([]);
    expect(await storedRoom(h, group.id)).toMatchObject({ encryptedName: null, nameKeyId: null });
  });

  it('refuses a group batch without a name even when it reaches the repository directly', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const group = await h.roomService.createGroupRoom(alice.user.id);
    const keyId = newKeyId();
    const { name: _name, ...payload } = generation(group.id, alice.user.id, [alice.user.id], { keyId });

    expect(await h.roomKeyRepository.publish({ ...payload, mode: 'generation', senderId: alice.user.id })).toBe('stale');
    expect(await h.roomKeyRepository.getState(group.id)).toMatchObject({ currentEpoch: 0 });
    expect(await storedRosters(h, group.id)).toEqual([]);
  });

  it('rejects names over 2 KB in a batch or a rename', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const aliceClient = await h.connectAs(alice);
    const group = await createGroup(aliceClient);
    const oversized = 'x'.repeat(2049);

    await expectError(aliceClient, 'e2e:publish-room-key', generation(group.id, alice.user.id, [alice.user.id], { name: oversized }), {
      code: 'validation.invalidPayload',
    });
    const first = generation(group.id, alice.user.id, [alice.user.id], { name: 'y'.repeat(2048) });
    await publish(aliceClient, first);
    await expectError(aliceClient, 'room:rename', { roomId: group.id, name: oversized, keyId: first.keyId }, {
      code: 'validation.invalidPayload',
      event: 'room:rename',
    });
    expect(await storedRoom(h, group.id)).toMatchObject({ encryptedName: 'y'.repeat(2048) });
  });

  it('stores the name with the winning batch and announces it to members only', async () => {
    const h = await start();
    const { alice, aliceClient, bobClient, group, members } = await groupOfTwo(h);
    const mallory = await h.createAccount('Mallory');
    const malloryClient = await h.connectAs(mallory);
    const malloryUpdates = collectEvents<NameUpdate>(malloryClient, 'room:name-updated');
    const bobUpdate = waitForEvent<NameUpdate>(bobClient, 'room:name-updated');
    const first = generation(group.id, alice.user.id, members);

    await publish(aliceClient, first);

    await expect(bobUpdate).resolves.toEqual({ roomId: group.id, encryptedName: first.name, keyId: first.keyId });
    expect(await storedRoom(h, group.id)).toEqual({ name: null, encryptedName: first.name, nameKeyId: first.keyId });
    expect((await summaryOf(bobClient, group.id))?.encryptedName).toEqual({ encryptedName: first.name, keyId: first.keyId });

    const room = await h.roomService.getRoomById(group.id);
    if (!room) {
      throw new Error('room missing');
    }
    expect((await h.roomService.buildSummary(room, mallory.user.id)).encryptedName).toBeNull();
    await roundTrip(malloryClient);
    await settle(50);
    expect(malloryUpdates).toEqual([]);
  });

  it('keeps the winner name when a losing batch for the same epoch arrives', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const aliceClient = await h.connectAs(alice);
    const group = await createGroup(aliceClient);
    const winner = generation(group.id, alice.user.id, [alice.user.id]);
    const loser = generation(group.id, alice.user.id, [alice.user.id]);

    await publish(aliceClient, winner);
    const rejected = waitForEvent<ErrorEvent>(aliceClient, 'e2e:room-key-rejected');
    aliceClient.emit('e2e:publish-room-key', loser);
    await expect(rejected).resolves.toMatchObject({ code: 'e2e.roomKeyStale' });

    expect(await storedRoom(h, group.id)).toMatchObject({ encryptedName: winner.name, nameKeyId: winner.keyId });
    expect(await storedRosters(h, group.id)).toEqual([{ keyId: winner.keyId, encryptedRoster: winner.roster }]);
  });

  it('replaces the name with every new generation', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const aliceClient = await h.connectAs(alice);
    const group = await createGroup(aliceClient);
    await publish(aliceClient, generation(group.id, alice.user.id, [alice.user.id]));

    const second = await rotate(h, aliceClient, alice, group.id, [alice.user.id], 2);

    expect(await storedRoom(h, group.id)).toMatchObject({ encryptedName: second.name, nameKeyId: second.keyId });
  });

  it('never stores a name on a private room', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const privateRoom = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    const updates = collectEvents<NameUpdate>(aliceClient, 'room:name-updated');

    await publish(aliceClient, generation(privateRoom.id, alice.user.id, [alice.user.id, bob.user.id]));

    expect(await storedRoom(h, privateRoom.id)).toEqual({ name: null, encryptedName: null, nameKeyId: null });
    expect(await storedRosters(h, privateRoom.id)).toEqual([]);
    await settle(50);
    expect(updates).toEqual([]);
  });
});

describe('renaming a group', () => {
  it('lets a member replace the name under the current key and tells every member', async () => {
    const h = await start();
    const { alice, aliceClient, bobClient, group, members } = await groupOfTwo(h);
    const first = generation(group.id, alice.user.id, members);
    await publishToMembers([aliceClient, bobClient], first);
    const renamed = fakeName(first.keyId, 'Novo nome');
    const aliceUpdate = waitForEvent<NameUpdate>(aliceClient, 'room:name-updated');
    const bobUpdate = waitForEvent<NameUpdate>(bobClient, 'room:name-updated');

    bobClient.emit('room:rename', { roomId: group.id, name: renamed, keyId: first.keyId });

    const expected = { roomId: group.id, encryptedName: renamed, keyId: first.keyId };
    await expect(aliceUpdate).resolves.toEqual(expected);
    await expect(bobUpdate).resolves.toEqual(expected);
    expect(await storedRoom(h, group.id)).toEqual({ name: null, encryptedName: renamed, nameKeyId: first.keyId });
  });

  it('refuses a rename under an old key and keeps the stored name', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const aliceClient = await h.connectAs(alice);
    const group = await createGroup(aliceClient);
    const first = generation(group.id, alice.user.id, [alice.user.id]);
    await publish(aliceClient, first);
    const second = await rotate(h, aliceClient, alice, group.id, [alice.user.id], 2);
    const updates = collectEvents<NameUpdate>(aliceClient, 'room:name-updated');

    await expectError(aliceClient, 'room:rename', { roomId: group.id, name: fakeName(first.keyId, 'Velho'), keyId: first.keyId }, {
      code: 'e2e.nameKeyStale',
      event: 'room:rename',
    });
    await expectError(aliceClient, 'room:rename', { roomId: group.id, name: fakeName('x', 'Sem chave'), keyId: newKeyId() }, {
      code: 'e2e.nameKeyStale',
      event: 'room:rename',
    });

    expect(await storedRoom(h, group.id)).toMatchObject({ encryptedName: second.name, nameKeyId: second.keyId });
    expect(updates).toEqual([]);
  });

  it('answers a non-member, a banned member, a private room and a missing room alike', async () => {
    const h = await start();
    const { alice, bob, aliceClient, bobClient, group, members } = await groupOfTwo(h);
    const first = generation(group.id, alice.user.id, members);
    await publish(aliceClient, first);
    const mallory = await h.createAccount('Mallory');
    const malloryClient = await h.connectAs(mallory);
    const privateRoom = await h.roomService.createPrivateRoom(alice.user.id, mallory.user.id);
    await h.roomKeyRepository.publish({
      ...generation(privateRoom.id, alice.user.id, [alice.user.id, mallory.user.id], { keyId: first.keyId }),
      mode: 'generation',
      senderId: alice.user.id,
    });
    const notFound = { code: 'room.notFound', event: 'room:rename' };

    await expectError(malloryClient, 'room:rename', { roomId: group.id, name: fakeName(first.keyId, 'Invasor'), keyId: first.keyId }, notFound);
    await expectError(malloryClient, 'room:rename', { roomId: privateRoom.id, name: fakeName(first.keyId, 'Privado'), keyId: first.keyId }, notFound);
    await expectError(malloryClient, 'room:rename', { roomId: 'missing-room', name: fakeName(first.keyId, 'Nada'), keyId: first.keyId }, notFound);

    await h.roomService.removeMember(group.id, alice.user.id, bob.user.id);
    await expectError(bobClient, 'room:rename', { roomId: group.id, name: fakeName(first.keyId, 'Ex membro'), keyId: first.keyId }, notFound);

    expect(await storedRoom(h, group.id)).toMatchObject({ encryptedName: first.name });
    expect(await storedRoom(h, privateRoom.id)).toMatchObject({ encryptedName: null });
  });

  it('rejects malformed rename payloads', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const aliceClient = await h.connectAs(alice);
    const group = await createGroup(aliceClient);
    const invalid = { code: 'validation.invalidPayload', event: 'room:rename' };

    await expectError(aliceClient, 'room:rename', { roomId: group.id, name: '', keyId: newKeyId() }, invalid);
    await expectError(aliceClient, 'room:rename', { roomId: group.id, name: 'blob', keyId: 'not a key id' }, invalid);
    await expectError(aliceClient, 'room:rename', { roomId: group.id, keyId: newKeyId() }, invalid);
  });
});

describe('rosters per generation', () => {
  it('stores each winning roster and delivers it with the envelopes of its own generation', async () => {
    const h = await start();
    const { alice, aliceClient, bobClient, group, members } = await groupOfTwo(h);
    const first = generation(group.id, alice.user.id, members);
    await publishToMembers([aliceClient, bobClient], first);
    const bobDeliveries = collectEvents<Delivery>(bobClient, 'e2e:room-key');

    const second = await rotate(h, aliceClient, alice, group.id, members, 2);

    await roundTrip(bobClient);
    await settle(50);
    expect(bobDeliveries).toEqual([expect.objectContaining({ keyId: second.keyId, roster: second.roster })]);
    expect(await storedRosters(h, group.id)).toEqual(
      [
        { keyId: first.keyId, encryptedRoster: first.roster },
        { keyId: second.keyId, encryptedRoster: second.roster },
      ].sort((a, b) => a.keyId.localeCompare(b.keyId)),
    );
    expect((await summaryOf(bobClient, group.id))?.roster).toEqual({ encryptedRoster: second.roster, keyId: second.keyId });
    expect(await getRoomKeys(bobClient, { roomIds: [group.id] })).toEqual([
      expect.objectContaining({ keyId: first.keyId, epoch: 1, roster: first.roster }),
      expect.objectContaining({ keyId: second.keyId, epoch: 2, roster: second.roster }),
    ]);
  });

  it('includes the roster of the shared generation when a holder shares it with a new member', async () => {
    const h = await start();
    const { alice, aliceClient, group, members } = await groupOfTwo(h);
    const first = generation(group.id, alice.user.id, members);
    await publish(aliceClient, first);
    const carol = await h.createAccount('Carol');
    const carolClient = await h.connectAs(carol);
    const { inviteToken } = await seedInvite(h.db, group.id, 'carol');
    const joined = waitForEvent(carolClient, 'room:joined');
    carolClient.emit('room:join-by-invite', { roomId: group.id, inviteToken, proof: fakeProof(carol.user.id) });
    await joined;

    const delivered = waitForEvent<Delivery>(carolClient, 'e2e:room-key');
    const { invite: _invite, roster: _roster, name: _name, ...share } = generation(group.id, alice.user.id, [carol.user.id], { keyId: first.keyId });
    aliceClient.emit('e2e:share-room-key', share);

    await expect(delivered).resolves.toMatchObject({ keyId: first.keyId, roster: first.roster });
  });

  it('delivers private room envelopes without a roster', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const privateRoom = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    const delivered = waitForEvent<Delivery>(aliceClient, 'e2e:room-key');
    aliceClient.emit('e2e:publish-room-key', generation(privateRoom.id, alice.user.id, [alice.user.id, bob.user.id]));

    expect(await delivered).not.toHaveProperty('roster');
    const [listed] = await getRoomKeys(aliceClient, { roomIds: [privateRoom.id] });
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('roster');
  });
});

describe('fetching only some room key generations', () => {
  async function threeGenerations(h: Harness) {
    const alice = await h.createAccount('Alice');
    const aliceClient = await h.connectAs(alice);
    const group = await createGroup(aliceClient);
    const other = await createGroup(aliceClient);
    const first = generation(group.id, alice.user.id, [alice.user.id]);
    await publish(aliceClient, first);
    const second = await rotate(h, aliceClient, alice, group.id, [alice.user.id], 2);
    const third = await rotate(h, aliceClient, alice, group.id, [alice.user.id], 3);
    const otherFirst = generation(other.id, alice.user.id, [alice.user.id]);
    await publish(aliceClient, otherFirst);
    return { alice, aliceClient, group, other, first, second, third, otherFirst };
  }

  it('returns only the requested generations of a filtered room and every generation of the others', async () => {
    const h = await start();
    const { aliceClient, group, other, first, third, otherFirst } = await threeGenerations(h);

    const keys = await getRoomKeys(aliceClient, { roomIds: [group.id, other.id], keyIds: { [group.id]: [first.keyId, third.keyId, newKeyId()] } });

    expect(keys.map((key) => key.keyId)).toEqual([first.keyId, third.keyId, otherFirst.keyId]);
    expect(keys[0]).toMatchObject({ roomId: group.id, epoch: 1, roster: first.roster });
  });

  it('ignores filters for rooms that were not asked for and never returns keys of rooms the user is not in', async () => {
    const h = await start();
    const { aliceClient, group, second } = await threeGenerations(h);
    const mallory = await h.createAccount('Mallory');
    const malloryClient = await h.connectAs(mallory);

    expect(await getRoomKeys(aliceClient, { roomIds: [group.id], keyIds: { [group.id]: [second.keyId], 'other-room': [newKeyId()] } })).toEqual([
      expect.objectContaining({ keyId: second.keyId }),
    ]);
    expect(await getRoomKeys(malloryClient, { roomIds: [group.id], keyIds: { [group.id]: [second.keyId] } })).toEqual([]);
  });

  it('keeps returning every generation when no filter is sent', async () => {
    const h = await start();
    const { aliceClient, group, first, second, third } = await threeGenerations(h);

    expect((await getRoomKeys(aliceClient, { roomIds: [group.id] })).map((key) => key.keyId)).toEqual([first.keyId, second.keyId, third.keyId]);
  });

  it('refuses more than 50 key ids for one room and malformed filters', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const aliceClient = await h.connectAs(alice);
    const group = await createGroup(aliceClient);
    const tooMany = Array.from({ length: 51 }, () => newKeyId());

    await expectError(aliceClient, 'e2e:get-room-keys', { roomIds: [group.id], keyIds: { [group.id]: tooMany } }, {
      code: 'e2e.lookupTooLarge',
      event: 'e2e:get-room-keys',
      params: { maxItems: 50 },
    });
    await expectError(aliceClient, 'e2e:get-room-keys', { roomIds: [group.id], keyIds: { [group.id]: ['bad id'] } }, {
      code: 'validation.invalidPayload',
      event: 'e2e:get-room-keys',
    });
    await expectError(aliceClient, 'e2e:get-room-keys', { roomIds: [group.id], keyIds: { [group.id]: [] } }, {
      code: 'validation.invalidPayload',
      event: 'e2e:get-room-keys',
    });
    expect(await getRoomKeys(aliceClient, { roomIds: [group.id], keyIds: { [group.id]: tooMany.slice(0, 50) } })).toEqual([]);
  });
});
