import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { listSocketEvents } from '@/docs/socket-registry.js';
import { fakeProof, seedInvite } from './support/invites.js';
import { newKeyId } from './support/room-keys.js';
import { collectEvents, roundTrip, settle, startSocketHarness, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

interface UserAvatarUpdate {
  userId: string;
  encryptedAvatar: string | null;
  profileKeyVersion: number;
}

interface RoomAvatarUpdate {
  roomId: string;
  encryptedAvatar: string | null;
  keyId: string | null;
}

interface ProfileKeysUpdate {
  roomId: string;
  keyId: string;
  envelopes: Record<string, string>;
}

interface ParticipantSummary {
  id: string;
  avatar: number;
  encryptedAvatar: string | null;
  profileKeyVersion: number;
  profileKeyEnvelope: { envelope: string; keyId: string } | null;
}

interface Summary {
  id: string;
  encryptedAvatar: { encryptedAvatar: string; keyId: string } | null;
  participants: ParticipantSummary[];
}

interface ErrorEvent {
  code: string;
  event?: string;
}

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function avatarUpload(h: Harness, uploaderId: string): Promise<{ key: string; url: string }> {
  const key = `uploads/avatars/${randomUUID()}.bin`;
  const url = await h.storeUpload(uploaderId, key, Buffer.alloc(32, 1));
  return { key, url: `${url}?e2e=1` };
}

async function setup() {
  const h = await startSocketHarness();
  harness = h;
  const alice = await h.createAccount('Alice');
  const bob = await h.createAccount('Bob');
  const carol = await h.createAccount('Carol');
  const mallory = await h.createAccount('Mallory');
  const aliceClient = await h.connectAs(alice);
  const aliceSecond = await h.connectAs(alice);
  const bobClient = await h.connectAs(bob);
  const carolClient = await h.connectAs(carol);
  const malloryClient = await h.connectAs(mallory);

  const created = waitForEvent<{ room: Summary }>(aliceClient, 'room:created');
  aliceClient.emit('room:create-group', {});
  const groupId = (await created).room.id;
  const { inviteToken } = await seedInvite(h.db, groupId);
  const joined = waitForEvent(bobClient, 'room:joined');
  bobClient.emit('room:join-by-invite', { roomId: groupId, inviteToken, proof: fakeProof(bob.user.id) });
  await joined;
  const keyId = await h.establishRoomKey(groupId);
  await h.roomService.createPrivateRoom(alice.user.id, carol.user.id);

  return { h, alice, bob, carol, mallory, aliceClient, aliceSecond, bobClient, carolClient, malloryClient, groupId, keyId };
}

async function expectError(client: TestClient, event: string, payload: unknown, code: string): Promise<void> {
  const error = waitForEvent<ErrorEvent>(client, 'error', (received) => received.event === event);
  client.emit(event, payload);
  await expect(error).resolves.toMatchObject({ code, event });
}

async function summaryOf(client: TestClient, roomId: string): Promise<Summary | undefined> {
  const listed = waitForEvent<{ rooms: Summary[] }>(client, 'rooms:list');
  client.emit('rooms:get');
  return (await listed).rooms.find((room) => room.id === roomId);
}

describe('avatar socket events', () => {
  it('are registered in the socket docs', () => {
    const names = listSocketEvents()
      .filter((descriptor) => descriptor.module === 'avatars')
      .map((descriptor) => `${descriptor.direction}:${descriptor.event}`);

    expect(names).toEqual(
      expect.arrayContaining([
        'client-to-server:user:set-avatar',
        'client-to-server:user:clear-avatar',
        'client-to-server:room:set-avatar',
        'client-to-server:room:clear-avatar',
        'client-to-server:room:publish-profile-key',
        'client-to-server:room:rewrap-profile-keys',
        'server-to-client:user:avatar-updated',
        'server-to-client:room:avatar-updated',
        'server-to-client:room:profile-keys-updated',
      ]),
    );
  });

  it('announce a new profile photo to every device of the owner and to contacts only', async () => {
    const { h, alice, aliceClient, aliceSecond, bobClient, carolClient, malloryClient } = await setup();
    const { url } = await avatarUpload(h, alice.user.id);
    const malloryUpdates = collectEvents<UserAvatarUpdate>(malloryClient, 'user:avatar-updated');
    const expected = { userId: alice.user.id, encryptedAvatar: 'alice-ptr', profileKeyVersion: 1 };
    const received = [aliceClient, aliceSecond, bobClient, carolClient].map((client) => waitForEvent<UserAvatarUpdate>(client, 'user:avatar-updated'));

    aliceClient.emit('user:set-avatar', { url, encryptedAvatar: 'alice-ptr', profileKeyVersion: 1 });

    for (const update of await Promise.all(received)) {
      expect(update).toEqual(expected);
    }
    await roundTrip(malloryClient);
    expect(malloryUpdates).toEqual([]);
  });

  it('announce a removed profile photo with a null pointer', async () => {
    const { h, alice, aliceClient, aliceSecond, bobClient, malloryClient } = await setup();
    const { url } = await avatarUpload(h, alice.user.id);
    const set = waitForEvent(aliceClient, 'user:avatar-updated');
    aliceClient.emit('user:set-avatar', { url, encryptedAvatar: 'alice-ptr', profileKeyVersion: 4 });
    await set;
    const malloryUpdates = collectEvents<UserAvatarUpdate>(malloryClient, 'user:avatar-updated');
    const received = [aliceSecond, bobClient].map((client) =>
      waitForEvent<UserAvatarUpdate>(client, 'user:avatar-updated', (update) => update.encryptedAvatar === null),
    );

    aliceClient.emit('user:clear-avatar', {});

    for (const update of await Promise.all(received)) {
      expect(update).toEqual({ userId: alice.user.id, encryptedAvatar: null, profileKeyVersion: 4 });
    }
    await roundTrip(malloryClient);
    expect(malloryUpdates).toEqual([]);
  });

  it('report a foreign upload as an error without announcing anything', async () => {
    const { h, bob, aliceClient, bobClient } = await setup();
    const { url } = await avatarUpload(h, bob.user.id);
    const updates = collectEvents(bobClient, 'user:avatar-updated');

    await expectError(aliceClient, 'user:set-avatar', { url, encryptedAvatar: 'ptr', profileKeyVersion: 1 }, 'user.avatarUploadInvalid');

    await settle(50);
    expect(updates).toEqual([]);
  });

  it('validate payload sizes', async () => {
    const { h, alice, aliceClient, groupId, keyId } = await setup();
    const { url } = await avatarUpload(h, alice.user.id);

    await expectError(aliceClient, 'user:set-avatar', { url, encryptedAvatar: 'x'.repeat(2049), profileKeyVersion: 1 }, 'validation.invalidPayload');
    await expectError(aliceClient, 'user:set-avatar', { url, encryptedAvatar: 'x', profileKeyVersion: 0 }, 'validation.invalidPayload');
    await expectError(aliceClient, 'room:set-avatar', { roomId: groupId, url, encryptedAvatar: 'x'.repeat(2049), keyId }, 'validation.invalidPayload');
    await expectError(aliceClient, 'room:publish-profile-key', { roomId: groupId, keyId, envelope: 'x'.repeat(1025) }, 'validation.invalidPayload');
    const tooMany = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`user-${index}`, 'env']));
    await expectError(aliceClient, 'room:rewrap-profile-keys', { roomId: groupId, keyId, envelopes: tooMany }, 'validation.invalidPayload');
  });

  it('announce a group photo to members only and expose it in their summaries', async () => {
    const { h, alice, aliceClient, bobClient, malloryClient, groupId, keyId } = await setup();
    const { url } = await avatarUpload(h, alice.user.id);
    const malloryUpdates = collectEvents(malloryClient, 'room:avatar-updated');
    const received = [aliceClient, bobClient].map((client) => waitForEvent<RoomAvatarUpdate>(client, 'room:avatar-updated'));

    aliceClient.emit('room:set-avatar', { roomId: groupId, url, encryptedAvatar: 'group-ptr', keyId });

    for (const update of await Promise.all(received)) {
      expect(update).toEqual({ roomId: groupId, encryptedAvatar: 'group-ptr', keyId });
    }
    expect((await summaryOf(bobClient, groupId))?.encryptedAvatar).toEqual({ encryptedAvatar: 'group-ptr', keyId });

    const cleared = [aliceClient, bobClient].map((client) =>
      waitForEvent<RoomAvatarUpdate>(client, 'room:avatar-updated', (update) => update.encryptedAvatar === null),
    );
    bobClient.emit('room:clear-avatar', { roomId: groupId });
    for (const update of await Promise.all(cleared)) {
      expect(update).toEqual({ roomId: groupId, encryptedAvatar: null, keyId: null });
    }
    expect((await summaryOf(aliceClient, groupId))?.encryptedAvatar).toBeNull();
    await roundTrip(malloryClient);
    expect(malloryUpdates).toEqual([]);
  });

  it('refuse a group photo from a non-member or under a stale key', async () => {
    const { h, alice, mallory, aliceClient, bobClient, malloryClient, groupId, keyId } = await setup();
    const updates = collectEvents(bobClient, 'room:avatar-updated');

    const malloryUpload = await avatarUpload(h, mallory.user.id);
    await expectError(malloryClient, 'room:set-avatar', { roomId: groupId, url: malloryUpload.url, encryptedAvatar: 'x', keyId }, 'room.notFound');
    await expectError(malloryClient, 'room:clear-avatar', { roomId: groupId }, 'room.notFound');

    const aliceUpload = await avatarUpload(h, alice.user.id);
    await expectError(aliceClient, 'room:set-avatar', { roomId: groupId, url: aliceUpload.url, encryptedAvatar: 'x', keyId: newKeyId() }, 'e2e.avatarKeyStale');

    await settle(50);
    expect(updates).toEqual([]);
  });

  it('announce published and rewrapped profile keys to members with only the rows written', async () => {
    const { alice, bob, aliceClient, bobClient, malloryClient, groupId, keyId } = await setup();
    const malloryUpdates = collectEvents(malloryClient, 'room:profile-keys-updated');

    const published = [aliceClient, bobClient].map((client) => waitForEvent<ProfileKeysUpdate>(client, 'room:profile-keys-updated'));
    bobClient.emit('room:publish-profile-key', { roomId: groupId, keyId, envelope: 'bob-env' });
    for (const update of await Promise.all(published)) {
      expect(update).toEqual({ roomId: groupId, keyId, envelopes: { [bob.user.id]: 'bob-env' } });
    }

    const rewrapped = [aliceClient, bobClient].map((client) =>
      waitForEvent<ProfileKeysUpdate>(client, 'room:profile-keys-updated', (update) => Object.hasOwn(update.envelopes, alice.user.id)),
    );
    aliceClient.emit('room:rewrap-profile-keys', { roomId: groupId, keyId, envelopes: { [alice.user.id]: 'alice-env', [bob.user.id]: 'bob-forged' } });
    for (const update of await Promise.all(rewrapped)) {
      expect(update).toEqual({ roomId: groupId, keyId, envelopes: { [alice.user.id]: 'alice-env' } });
    }

    const summary = await summaryOf(bobClient, groupId);
    expect(summary?.participants).toEqual([
      expect.objectContaining({ id: alice.user.id, avatar: 0, encryptedAvatar: null, profileKeyVersion: 1, profileKeyEnvelope: { envelope: 'alice-env', keyId } }),
      expect.objectContaining({ id: bob.user.id, avatar: 0, encryptedAvatar: null, profileKeyVersion: 1, profileKeyEnvelope: { envelope: 'bob-env', keyId } }),
    ]);
    await roundTrip(malloryClient);
    expect(malloryUpdates).toEqual([]);
  });

  it('refuse profile keys from non-members, under stale keys or for non-members', async () => {
    const { mallory, aliceClient, malloryClient, groupId, keyId } = await setup();

    await expectError(malloryClient, 'room:publish-profile-key', { roomId: groupId, keyId, envelope: 'env' }, 'room.notFound');
    await expectError(aliceClient, 'room:publish-profile-key', { roomId: groupId, keyId: newKeyId(), envelope: 'env' }, 'e2e.profileKeyStale');
    await expectError(aliceClient, 'room:rewrap-profile-keys', { roomId: groupId, keyId, envelopes: { [mallory.user.id]: 'env' } }, 'room.notMember');
  });

  it('include the own photo pointer and profile key version in the resumed user', async () => {
    const { h, alice, aliceClient } = await setup();
    const { url } = await avatarUpload(h, alice.user.id);
    const set = waitForEvent(aliceClient, 'user:avatar-updated');
    aliceClient.emit('user:set-avatar', { url, encryptedAvatar: 'alice-ptr', profileKeyVersion: 2 });
    await set;

    const client = await h.connect();
    const resumed = waitForEvent<{ user: { encryptedAvatar: string | null; profileKeyVersion: number; avatar: number } }>(client, 'user:resumed');
    client.emit('user:join', { mode: 'resume', userId: alice.user.id, sessionToken: alice.sessionToken });

    expect((await resumed).user).toMatchObject({ avatar: 0, encryptedAvatar: 'alice-ptr', profileKeyVersion: 2 });
  });
});
