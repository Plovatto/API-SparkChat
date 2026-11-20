import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { roomBans, roomParticipants, rooms, uploads, users } from '@/database/schema.js';
import { ExpiredUploadSweeper } from '@/storage/expired-upload-sweeper.js';
import { resolveAvatarObjectKey, resolveObjectKey } from '@/storage/object-storage-url.js';
import { ORPHAN_UPLOAD_MAX_AGE_MS, OrphanUploadSweeper } from '@/storage/orphan-upload-sweeper.js';
import { buildRoomService } from './support/build-room-service.js';
import { establishFakeGeneration, newKeyId } from './support/room-keys.js';
import { settle } from './support/socket-harness.js';
import { TEST_V2_SIGNUP } from './support/test-constants.js';

type Services = Awaited<ReturnType<typeof buildRoomService>>;

const POINTER = 'e2e:v1:'.padEnd(200, 'p');

async function createUser(services: Services, nickname: string) {
  const { user } = await services.userService.registerAccount({ nickname, avatar: 3, password: 'correct-horse-battery-staple-0123456789abcd', ...TEST_V2_SIGNUP });
  return user;
}

function avatarKey(): string {
  return `uploads/avatars/${randomUUID()}.bin`;
}

async function storeAvatar(services: Services, uploaderId: string, size = 64): Promise<{ key: string; url: string }> {
  const key = avatarKey();
  const url = await services.storeUpload(uploaderId, key, Buffer.alloc(size, 1));
  await services.storageQuota.recordUsage(size);
  return { key, url: `${url}?e2e=1` };
}

async function groupWith(services: Services, ownerId: string, memberIds: string[]) {
  const room = await services.roomService.createGroupRoom(ownerId);
  for (const memberId of memberIds) {
    await services.joinGroup(room.id, memberId);
  }
  const keyId = await establishFakeGeneration(services.roomKeyRepository, room.id, ownerId, [ownerId, ...memberIds], newKeyId());
  return { roomId: room.id, keyId };
}

async function userColumns(services: Services, userId: string) {
  const [row] = await services.db
    .select({ encryptedAvatar: users.encryptedAvatar, avatarUploadKey: users.avatarUploadKey, profileKeyVersion: users.profileKeyVersion })
    .from(users)
    .where(eq(users.id, userId));
  return row;
}

describe('user avatars', () => {
  it('claims the user’s own upload and stores the encrypted pointer', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const { key, url } = await storeAvatar(services, alice.id);

    await expect(services.avatarService.setUserAvatar(alice.id, { url, encryptedAvatar: POINTER, profileKeyVersion: 1 })).resolves.toEqual({
      userId: alice.id,
      encryptedAvatar: POINTER,
      profileKeyVersion: 1,
    });

    await expect(userColumns(services, alice.id)).resolves.toEqual({ encryptedAvatar: POINTER, avatarUploadKey: key, profileKeyVersion: 1 });
    await expect(services.uploadRegistry.find(key)).resolves.toMatchObject({ avatarOwner: `user:${alice.id}`, messageId: null });
  });

  it('refuses an upload that belongs to someone else', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const mallory = await createUser(services, 'Mallory');
    const { key, url } = await storeAvatar(services, alice.id);

    await expect(services.avatarService.setUserAvatar(mallory.id, { url, encryptedAvatar: POINTER, profileKeyVersion: 1 })).rejects.toMatchObject({
      code: 'user.avatarUploadInvalid',
    });
    await expect(services.uploadRegistry.find(key)).resolves.toMatchObject({ avatarOwner: null });
    await expect(userColumns(services, mallory.id)).resolves.toMatchObject({ encryptedAvatar: null, avatarUploadKey: null });
  });

  it('refuses another user’s current avatar even with the right url', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const mallory = await createUser(services, 'Mallory');
    const { url } = await storeAvatar(services, alice.id);
    await services.avatarService.setUserAvatar(alice.id, { url, encryptedAvatar: POINTER, profileKeyVersion: 1 });

    await expect(services.avatarService.setUserAvatar(mallory.id, { url, encryptedAvatar: POINTER, profileKeyVersion: 1 })).rejects.toMatchObject({
      code: 'user.avatarUploadInvalid',
    });
  });

  it('refuses message uploads, foreign hosts and uploads already attached to a message', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const imageUrl = await services.storeUpload(alice.id, 'uploads/images/photo.bin');
    const { key, url } = await storeAvatar(services, alice.id);
    const foreign = `https://evil.test/${key}`;

    for (const candidate of [imageUrl, foreign, 'not a url']) {
      await expect(services.avatarService.setUserAvatar(alice.id, { url: candidate, encryptedAvatar: POINTER, profileKeyVersion: 1 })).rejects.toMatchObject({
        code: 'user.avatarUploadInvalid',
      });
    }

    await expect(services.uploadRegistry.claim([key], alice.id, 'message-1')).resolves.toBe(true);
    await expect(services.uploadRegistry.find(key)).resolves.toMatchObject({ messageId: 'message-1' });
    await expect(services.avatarService.setUserAvatar(alice.id, { url, encryptedAvatar: POINTER, profileKeyVersion: 1 })).rejects.toMatchObject({
      code: 'user.avatarUploadInvalid',
    });
  });

  it('never lets a message claim an avatar upload', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const { key, url } = await storeAvatar(services, alice.id);
    await services.avatarService.setUserAvatar(alice.id, { url, encryptedAvatar: POINTER, profileKeyVersion: 1 });

    await expect(services.uploadRegistry.claim([key], alice.id, 'message-1')).resolves.toBe(false);
    await expect(services.messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: url, type: 'image' })).rejects.toMatchObject({
      code: 'message.invalidMedia',
    });
    await expect(services.uploadRegistry.find(key)).resolves.toMatchObject({ messageId: null, avatarOwner: `user:${alice.id}` });
  });

  it('rejects a profile key version older than the current one', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const first = await storeAvatar(services, alice.id);
    await services.avatarService.setUserAvatar(alice.id, { url: first.url, encryptedAvatar: POINTER, profileKeyVersion: 3 });
    const second = await storeAvatar(services, alice.id);

    await expect(services.avatarService.setUserAvatar(alice.id, { url: second.url, encryptedAvatar: POINTER, profileKeyVersion: 2 })).rejects.toMatchObject({
      code: 'user.profileKeyVersionStale',
    });
    await expect(services.uploadRegistry.find(second.key)).resolves.toMatchObject({ avatarOwner: null });
    await expect(userColumns(services, alice.id)).resolves.toMatchObject({ avatarUploadKey: first.key, profileKeyVersion: 3 });
  });

  it('replacing the photo deletes the old object and releases its quota', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const first = await storeAvatar(services, alice.id, 100);
    const second = await storeAvatar(services, alice.id, 40);
    await services.avatarService.setUserAvatar(alice.id, { url: first.url, encryptedAvatar: POINTER, profileKeyVersion: 1 });
    expect(await services.storageUsageRepository.getBytesUsed()).toBe(140);

    await services.avatarService.setUserAvatar(alice.id, { url: second.url, encryptedAvatar: `${POINTER}2`, profileKeyVersion: 2 });

    await expect(services.objectStorage.getObject(first.key)).resolves.toBeNull();
    await expect(services.uploadRegistry.find(first.key)).resolves.toBeNull();
    await expect(services.objectStorage.getObject(second.key)).resolves.not.toBeNull();
    expect(await services.storageUsageRepository.getBytesUsed()).toBe(40);
    expect(await services.uploadRegistry.totalBytesFor(alice.id)).toBe(40);
    await expect(userColumns(services, alice.id)).resolves.toEqual({ encryptedAvatar: `${POINTER}2`, avatarUploadKey: second.key, profileKeyVersion: 2 });
  });

  it('re-sealing the pointer with the same upload keeps the object', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const { key, url } = await storeAvatar(services, alice.id);
    await services.avatarService.setUserAvatar(alice.id, { url, encryptedAvatar: POINTER, profileKeyVersion: 1 });

    await services.avatarService.setUserAvatar(alice.id, { url, encryptedAvatar: `${POINTER}v2`, profileKeyVersion: 2 });

    await expect(services.objectStorage.getObject(key)).resolves.not.toBeNull();
    await expect(userColumns(services, alice.id)).resolves.toEqual({ encryptedAvatar: `${POINTER}v2`, avatarUploadKey: key, profileKeyVersion: 2 });
  });

  it('clearing the photo deletes the object, the registry row and the quota', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const { key, url } = await storeAvatar(services, alice.id, 70);
    await services.avatarService.setUserAvatar(alice.id, { url, encryptedAvatar: POINTER, profileKeyVersion: 2 });

    await expect(services.avatarService.clearUserAvatar(alice.id)).resolves.toEqual({ userId: alice.id, encryptedAvatar: null, profileKeyVersion: 2 });

    await expect(services.objectStorage.getObject(key)).resolves.toBeNull();
    await expect(services.uploadRegistry.find(key)).resolves.toBeNull();
    expect(await services.storageUsageRepository.getBytesUsed()).toBe(0);
    await expect(userColumns(services, alice.id)).resolves.toEqual({ encryptedAvatar: null, avatarUploadKey: null, profileKeyVersion: 2 });
    await expect(services.avatarService.clearUserAvatar(alice.id)).resolves.toMatchObject({ encryptedAvatar: null });
  });
});

describe('avatars and gifs stay apart', () => {
  it('never accepts a gif upload or an expiring upload as a photo', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const gifKey = `uploads/gifs/${randomUUID()}.bin`;
    await services.objectStorage.putObject(gifKey, Buffer.from('gif'), { contentType: 'application/octet-stream' });
    await services.uploadRegistry.register(gifKey, alice.id, 3, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const forgedKey = avatarKey();
    await services.objectStorage.putObject(forgedKey, Buffer.from('ava'), { contentType: 'application/octet-stream' });
    await services.uploadRegistry.register(forgedKey, alice.id, 3, { expiresAt: new Date(Date.now() + 60_000).toISOString() });

    for (const key of [gifKey, forgedKey]) {
      const url = `${services.objectStorage.publicUrl(key)}?e2e=1`;
      await expect(services.avatarService.setUserAvatar(alice.id, { url, encryptedAvatar: POINTER, profileKeyVersion: 1 })).rejects.toMatchObject({
        code: 'user.avatarUploadInvalid',
      });
      await expect(services.uploadRegistry.find(key)).resolves.toMatchObject({ avatarOwner: null });
    }
    expect(resolveAvatarObjectKey(services.objectStorage.publicUrl(gifKey))).toBeNull();
    expect(resolveObjectKey(services.objectStorage.publicUrl(forgedKey))).toBeNull();
  });

  it('never lets a gif message claim a photo upload', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const { key, url } = await storeAvatar(services, alice.id);

    await expect(services.messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: url, type: 'image' })).rejects.toMatchObject({
      code: 'message.invalidMedia',
    });
    await expect(services.uploadRegistry.find(key)).resolves.toMatchObject({ messageId: null });
  });

  it('never lets the expired upload sweeper remove a photo in use, and still counts photos in the user quota', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const { key, url } = await storeAvatar(services, alice.id, 25);
    await services.avatarService.setUserAvatar(alice.id, { url, encryptedAvatar: POINTER, profileKeyVersion: 1 });
    expect(await services.uploadRegistry.totalBytesFor(alice.id)).toBe(25);
    await services.db.update(uploads).set({ expiresAt: new Date(Date.now() - 60_000).toISOString() }).where(eq(uploads.key, key));

    await expect(new ExpiredUploadSweeper(services.uploadRegistry, services.objectStorage, services.storageQuota).sweep()).resolves.toBe(0);

    await expect(services.uploadRegistry.find(key)).resolves.not.toBeNull();
    await expect(services.objectStorage.getObject(key)).resolves.not.toBeNull();
  });
});

describe('concurrent photo changes', () => {
  it('two concurrent set-avatar calls leave exactly one photo stored and the quota consistent', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const first = await storeAvatar(services, alice.id, 30);
    const second = await storeAvatar(services, alice.id, 50);

    const results = await Promise.allSettled([
      services.avatarService.setUserAvatar(alice.id, { url: first.url, encryptedAvatar: 'first', profileKeyVersion: 1 }),
      services.avatarService.setUserAvatar(alice.id, { url: second.url, encryptedAvatar: 'second', profileKeyVersion: 1 }),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    const stored = await userColumns(services, alice.id);
    const kept = stored?.avatarUploadKey === first.key ? first : second;
    const dropped = kept === first ? second : first;
    expect(stored?.encryptedAvatar).toBe(kept === first ? 'first' : 'second');
    await expect(services.uploadRegistry.find(kept.key)).resolves.toMatchObject({ avatarOwner: `user:${alice.id}` });
    await expect(services.objectStorage.getObject(kept.key)).resolves.not.toBeNull();
    await expect(services.uploadRegistry.find(dropped.key)).resolves.toBeNull();
    await expect(services.objectStorage.getObject(dropped.key)).resolves.toBeNull();
    expect(await services.storageUsageRepository.getBytesUsed()).toBe(kept === first ? 30 : 50);
    expect(await services.uploadRegistry.totalBytesFor(alice.id)).toBe(kept === first ? 30 : 50);
  });

  it('two concurrent set-avatar calls with the same upload keep it', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const { key, url } = await storeAvatar(services, alice.id, 30);

    await Promise.all([
      services.avatarService.setUserAvatar(alice.id, { url, encryptedAvatar: 'a', profileKeyVersion: 1 }),
      services.avatarService.setUserAvatar(alice.id, { url, encryptedAvatar: 'b', profileKeyVersion: 1 }),
    ]);

    await expect(userColumns(services, alice.id)).resolves.toMatchObject({ avatarUploadKey: key });
    await expect(services.objectStorage.getObject(key)).resolves.not.toBeNull();
    expect(await services.storageUsageRepository.getBytesUsed()).toBe(30);
  });
});

describe('group avatars', () => {
  it('lets a member in the current roster set the photo and replaces the previous one', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const bob = await createUser(services, 'Bob');
    const { roomId, keyId } = await groupWith(services, alice.id, [bob.id]);
    const first = await storeAvatar(services, alice.id, 30);
    const second = await storeAvatar(services, bob.id, 20);

    await expect(services.avatarService.setRoomAvatar(alice.id, { roomId, url: first.url, encryptedAvatar: POINTER, keyId })).resolves.toEqual({
      roomId,
      encryptedAvatar: POINTER,
      keyId,
    });
    await expect(services.uploadRegistry.find(first.key)).resolves.toMatchObject({ avatarOwner: `room:${roomId}` });

    await services.avatarService.setRoomAvatar(bob.id, { roomId, url: second.url, encryptedAvatar: `${POINTER}b`, keyId });

    await expect(services.objectStorage.getObject(first.key)).resolves.toBeNull();
    await expect(services.uploadRegistry.find(first.key)).resolves.toBeNull();
    expect(await services.storageUsageRepository.getBytesUsed()).toBe(20);
    const room = await services.roomService.getRoomById(roomId);
    expect(room).toMatchObject({ encryptedAvatar: `${POINTER}b`, avatarKeyId: keyId });
  });

  it('lets whoever rotates the key re-seal the current photo with the new key', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const bob = await createUser(services, 'Bob');
    const { roomId, keyId } = await groupWith(services, alice.id, [bob.id]);
    const { key, url } = await storeAvatar(services, alice.id);
    await services.avatarService.setRoomAvatar(alice.id, { roomId, url, encryptedAvatar: POINTER, keyId });
    await services.roomKeyRepository.markRotationRequired(roomId);
    const nextKeyId = await establishFakeGeneration(services.roomKeyRepository, roomId, bob.id, [alice.id, bob.id], newKeyId(), 2);

    await services.avatarService.setRoomAvatar(bob.id, { roomId, url, encryptedAvatar: `${POINTER}n`, keyId: nextKeyId });

    await expect(services.objectStorage.getObject(key)).resolves.not.toBeNull();
    expect(await services.roomService.getRoomById(roomId)).toMatchObject({ encryptedAvatar: `${POINTER}n`, avatarKeyId: nextKeyId });
  });

  it('refuses non-members, members outside the roster, stale keys, private rooms and foreign uploads', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const bob = await createUser(services, 'Bob');
    const mallory = await createUser(services, 'Mallory');
    const late = await createUser(services, 'Late');
    const { roomId, keyId } = await groupWith(services, alice.id, [bob.id]);
    await settle(5);
    await services.joinGroup(roomId, late.id);

    const malloryUpload = await storeAvatar(services, mallory.id);
    await expect(services.avatarService.setRoomAvatar(mallory.id, { roomId, url: malloryUpload.url, encryptedAvatar: POINTER, keyId })).rejects.toMatchObject({
      code: 'room.notFound',
    });

    const lateUpload = await storeAvatar(services, late.id);
    await expect(services.avatarService.setRoomAvatar(late.id, { roomId, url: lateUpload.url, encryptedAvatar: POINTER, keyId })).rejects.toMatchObject({
      code: 'e2e.avatarRequiresRoster',
    });

    const aliceUpload = await storeAvatar(services, alice.id);
    await expect(
      services.avatarService.setRoomAvatar(alice.id, { roomId, url: aliceUpload.url, encryptedAvatar: POINTER, keyId: newKeyId() }),
    ).rejects.toMatchObject({ code: 'e2e.avatarKeyStale' });

    await expect(services.avatarService.setRoomAvatar(alice.id, { roomId, url: lateUpload.url, encryptedAvatar: POINTER, keyId })).rejects.toMatchObject({
      code: 'room.avatarUploadInvalid',
    });

    const privateRoom = await services.roomService.createPrivateRoom(alice.id, bob.id);
    await expect(
      services.avatarService.setRoomAvatar(alice.id, { roomId: privateRoom.id, url: aliceUpload.url, encryptedAvatar: POINTER, keyId }),
    ).rejects.toMatchObject({ code: 'room.notFound' });

    for (const key of [malloryUpload.key, lateUpload.key, aliceUpload.key]) {
      await expect(services.uploadRegistry.find(key)).resolves.toMatchObject({ avatarOwner: null });
    }
    expect(await services.roomService.getRoomById(roomId)).toMatchObject({ encryptedAvatar: undefined });
  });

  it('clears the group photo under the same permission rules', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const bob = await createUser(services, 'Bob');
    const mallory = await createUser(services, 'Mallory');
    const { roomId, keyId } = await groupWith(services, alice.id, [bob.id]);
    const { key, url } = await storeAvatar(services, alice.id, 50);
    await services.avatarService.setRoomAvatar(alice.id, { roomId, url, encryptedAvatar: POINTER, keyId });

    await expect(services.avatarService.clearRoomAvatar(mallory.id, roomId)).rejects.toMatchObject({ code: 'room.notFound' });
    await expect(services.avatarService.clearRoomAvatar(bob.id, roomId)).resolves.toEqual({ roomId, encryptedAvatar: null, keyId: null });

    await expect(services.objectStorage.getObject(key)).resolves.toBeNull();
    await expect(services.uploadRegistry.find(key)).resolves.toBeNull();
    expect(await services.storageUsageRepository.getBytesUsed()).toBe(0);
    const [row] = await services.db.select().from(rooms).where(eq(rooms.id, roomId));
    expect(row).toMatchObject({ encryptedAvatar: null, avatarKeyId: null, avatarUploadKey: null });
  });
});

describe('profile key envelopes', () => {
  async function envelopes(services: Services, roomId: string) {
    const rows = await services.db
      .select({ userId: roomParticipants.userId, envelope: roomParticipants.profileKeyEnvelope, keyId: roomParticipants.profileKeyKeyId })
      .from(roomParticipants)
      .where(eq(roomParticipants.roomId, roomId));
    return Object.fromEntries(rows.map((row) => [row.userId, row.envelope ? { envelope: row.envelope, keyId: row.keyId } : null]));
  }

  it('publish writes only the caller’s own row and always overwrites it', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const bob = await createUser(services, 'Bob');
    const { roomId, keyId } = await groupWith(services, alice.id, [bob.id]);

    await expect(services.avatarService.publishProfileKey(alice.id, { roomId, keyId, envelope: 'env-a1' })).resolves.toEqual({
      roomId,
      keyId,
      envelopes: { [alice.id]: 'env-a1' },
    });
    await services.avatarService.publishProfileKey(alice.id, { roomId, keyId, envelope: 'env-a2' });

    await expect(envelopes(services, roomId)).resolves.toEqual({ [alice.id]: { envelope: 'env-a2', keyId }, [bob.id]: null });
  });

  it('publish refuses non-members and stale keys', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const mallory = await createUser(services, 'Mallory');
    const { roomId, keyId } = await groupWith(services, alice.id, []);

    await expect(services.avatarService.publishProfileKey(mallory.id, { roomId, keyId, envelope: 'env' })).rejects.toMatchObject({ code: 'room.notFound' });
    await expect(services.avatarService.publishProfileKey(alice.id, { roomId, keyId: newKeyId(), envelope: 'env' })).rejects.toMatchObject({
      code: 'e2e.profileKeyStale',
    });
    await expect(envelopes(services, roomId)).resolves.toEqual({ [alice.id]: null });
  });

  it('rewrap writes only missing envelopes for other members and lets the owner always win', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const bob = await createUser(services, 'Bob');
    const carol = await createUser(services, 'Carol');
    const { roomId, keyId } = await groupWith(services, alice.id, [bob.id, carol.id]);
    await services.avatarService.publishProfileKey(bob.id, { roomId, keyId, envelope: 'bob-own' });

    await expect(
      services.avatarService.rewrapProfileKeys(alice.id, { roomId, keyId, envelopes: { [alice.id]: 'alice-r', [bob.id]: 'bob-r', [carol.id]: 'carol-r' } }),
    ).resolves.toEqual({ roomId, keyId, envelopes: { [alice.id]: 'alice-r', [carol.id]: 'carol-r' } });

    await expect(
      services.avatarService.rewrapProfileKeys(bob.id, { roomId, keyId, envelopes: { [carol.id]: 'carol-second' } }),
    ).resolves.toEqual({ roomId, keyId, envelopes: {} });

    await services.avatarService.publishProfileKey(carol.id, { roomId, keyId, envelope: 'carol-own' });

    await expect(envelopes(services, roomId)).resolves.toEqual({
      [alice.id]: { envelope: 'alice-r', keyId },
      [bob.id]: { envelope: 'bob-own', keyId },
      [carol.id]: { envelope: 'carol-own', keyId },
    });
  });

  it('rewrap replaces envelopes of an older key after a rotation', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const bob = await createUser(services, 'Bob');
    const { roomId, keyId } = await groupWith(services, alice.id, [bob.id]);
    await services.avatarService.publishProfileKey(bob.id, { roomId, keyId, envelope: 'bob-old' });
    await services.roomKeyRepository.markRotationRequired(roomId);
    const nextKeyId = await establishFakeGeneration(services.roomKeyRepository, roomId, alice.id, [alice.id, bob.id], newKeyId(), 2);

    await services.avatarService.rewrapProfileKeys(alice.id, { roomId, keyId: nextKeyId, envelopes: { [bob.id]: 'bob-new' } });

    await expect(envelopes(services, roomId)).resolves.toMatchObject({ [bob.id]: { envelope: 'bob-new', keyId: nextKeyId } });
  });

  it('rewrap refuses non-members, stale keys and envelopes for users outside the room', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const bob = await createUser(services, 'Bob');
    const mallory = await createUser(services, 'Mallory');
    const { roomId, keyId } = await groupWith(services, alice.id, [bob.id]);

    await expect(services.avatarService.rewrapProfileKeys(mallory.id, { roomId, keyId, envelopes: { [bob.id]: 'x' } })).rejects.toMatchObject({
      code: 'room.notFound',
    });
    await expect(services.avatarService.rewrapProfileKeys(alice.id, { roomId, keyId: newKeyId(), envelopes: { [bob.id]: 'x' } })).rejects.toMatchObject({
      code: 'e2e.profileKeyStale',
    });
    await expect(
      services.avatarService.rewrapProfileKeys(alice.id, { roomId, keyId, envelopes: { [bob.id]: 'x', [mallory.id]: 'y' } }),
    ).rejects.toMatchObject({ code: 'room.notMember' });
    await expect(envelopes(services, roomId)).resolves.toEqual({ [alice.id]: null, [bob.id]: null });
  });

  it('a member who leaves loses the envelope and starts clean when rejoining', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const bob = await createUser(services, 'Bob');
    const { roomId, keyId } = await groupWith(services, alice.id, [bob.id]);
    await services.avatarService.publishProfileKey(bob.id, { roomId, keyId, envelope: 'bob-own' });

    await services.roomService.leaveGroup(roomId, bob.id);
    await services.joinGroup(roomId, bob.id);

    await expect(envelopes(services, roomId)).resolves.toMatchObject({ [bob.id]: null });
  });

  it('publishing the same envelope again writes and announces nothing', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const bob = await createUser(services, 'Bob');
    const { roomId, keyId } = await groupWith(services, alice.id, [bob.id]);
    await services.avatarService.publishProfileKey(alice.id, { roomId, keyId, envelope: 'env-a' });

    await expect(services.avatarService.publishProfileKey(alice.id, { roomId, keyId, envelope: 'env-a' })).resolves.toEqual({ roomId, keyId, envelopes: {} });
    await expect(
      services.avatarService.rewrapProfileKeys(alice.id, { roomId, keyId, envelopes: { [alice.id]: 'env-a', [bob.id]: 'env-b' } }),
    ).resolves.toEqual({ roomId, keyId, envelopes: { [bob.id]: 'env-b' } });
    await expect(
      services.avatarService.rewrapProfileKeys(alice.id, { roomId, keyId, envelopes: { [alice.id]: 'env-a', [bob.id]: 'env-b' } }),
    ).resolves.toEqual({ roomId, keyId, envelopes: {} });
    await expect(services.avatarService.publishProfileKey(alice.id, { roomId, keyId, envelope: 'env-a2' })).resolves.toEqual({
      roomId,
      keyId,
      envelopes: { [alice.id]: 'env-a2' },
    });
  });

  it('a banned member can neither publish nor rewrap, even before the ban purge runs', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const bob = await createUser(services, 'Bob');
    const carol = await createUser(services, 'Carol');
    const { roomId, keyId } = await groupWith(services, alice.id, [bob.id, carol.id]);
    await services.db.insert(roomBans).values({ roomId, userId: bob.id, bannedBy: alice.id, bannedAt: new Date().toISOString() });

    await expect(services.avatarService.publishProfileKey(bob.id, { roomId, keyId, envelope: 'bob' })).rejects.toMatchObject({ code: 'room.notFound' });
    await expect(services.avatarService.rewrapProfileKeys(bob.id, { roomId, keyId, envelopes: { [carol.id]: 'carol' } })).rejects.toMatchObject({
      code: 'room.notFound',
    });
    await expect(services.avatarService.rewrapProfileKeys(alice.id, { roomId, keyId, envelopes: { [bob.id]: 'bob' } })).rejects.toMatchObject({
      code: 'room.notMember',
    });
    await expect(envelopes(services, roomId)).resolves.toEqual({ [alice.id]: null, [bob.id]: null, [carol.id]: null });

    await services.roomService.removeMember(roomId, alice.id, carol.id);
    await expect(services.avatarService.publishProfileKey(carol.id, { roomId, keyId, envelope: 'carol' })).rejects.toMatchObject({ code: 'room.notFound' });
  });

  it('a removed member loses the envelope', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const bob = await createUser(services, 'Bob');
    const { roomId, keyId } = await groupWith(services, alice.id, [bob.id]);
    await services.avatarService.publishProfileKey(bob.id, { roomId, keyId, envelope: 'bob-own' });

    await services.roomService.removeMember(roomId, alice.id, bob.id);

    await expect(envelopes(services, roomId)).resolves.toEqual({ [alice.id]: null });
  });
});

describe('room summaries', () => {
  it('give members the group photo, each participant’s pointer and only current-key envelopes', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const bob = await createUser(services, 'Bob');
    const { roomId, keyId } = await groupWith(services, alice.id, [bob.id]);
    const roomUpload = await storeAvatar(services, alice.id);
    const aliceUpload = await storeAvatar(services, alice.id);
    await services.avatarService.setRoomAvatar(alice.id, { roomId, url: roomUpload.url, encryptedAvatar: 'room-ptr', keyId });
    await services.avatarService.setUserAvatar(alice.id, { url: aliceUpload.url, encryptedAvatar: 'alice-ptr', profileKeyVersion: 2 });
    await services.avatarService.publishProfileKey(alice.id, { roomId, keyId, envelope: 'alice-env' });
    await services.avatarService.publishProfileKey(bob.id, { roomId, keyId, envelope: 'bob-env' });

    const room = await services.roomService.getRoomById(roomId);
    if (!room) {
      throw new Error('room missing');
    }
    const summary = await services.roomService.buildSummary(room, bob.id);

    expect(summary.encryptedAvatar).toEqual({ encryptedAvatar: 'room-ptr', keyId });
    expect(summary.participants).toEqual([
      expect.objectContaining({ id: alice.id, avatar: 3, encryptedAvatar: 'alice-ptr', profileKeyVersion: 2, profileKeyEnvelope: { envelope: 'alice-env', keyId } }),
      expect.objectContaining({ id: bob.id, avatar: 3, encryptedAvatar: null, profileKeyVersion: 1, profileKeyEnvelope: { envelope: 'bob-env', keyId } }),
    ]);

    await services.roomKeyRepository.markRotationRequired(roomId);
    await establishFakeGeneration(services.roomKeyRepository, roomId, alice.id, [alice.id, bob.id], newKeyId(), 2);
    const rotated = await services.roomService.getRoomById(roomId);
    if (!rotated) {
      throw new Error('room missing');
    }
    const afterRotation = await services.roomService.buildSummary(rotated, bob.id);
    expect(afterRotation.participants.map((participant) => participant.profileKeyEnvelope)).toEqual([null, null]);
    expect(afterRotation.encryptedAvatar).toEqual({ encryptedAvatar: 'room-ptr', keyId });
  });

  it('hide the photo, pointers and envelopes from non-members', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const mallory = await createUser(services, 'Mallory');
    const { roomId, keyId } = await groupWith(services, alice.id, []);
    const roomUpload = await storeAvatar(services, alice.id);
    const aliceUpload = await storeAvatar(services, alice.id);
    await services.avatarService.setRoomAvatar(alice.id, { roomId, url: roomUpload.url, encryptedAvatar: 'room-ptr', keyId });
    await services.avatarService.setUserAvatar(alice.id, { url: aliceUpload.url, encryptedAvatar: 'alice-ptr', profileKeyVersion: 1 });
    await services.avatarService.publishProfileKey(alice.id, { roomId, keyId, envelope: 'alice-env' });

    const room = await services.roomService.getRoomById(roomId);
    if (!room) {
      throw new Error('room missing');
    }
    const summary = await services.roomService.buildSummary(room, mallory.id);

    expect(summary.encryptedAvatar).toBeNull();
    expect(summary.participants).toEqual([expect.objectContaining({ id: alice.id, avatar: 3, encryptedAvatar: null, profileKeyEnvelope: null })]);
  });

  it('include participant pointers and envelopes in private rooms but no room photo', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const bob = await createUser(services, 'Bob');
    const room = await services.roomService.createPrivateRoom(alice.id, bob.id);
    const keyId = await establishFakeGeneration(services.roomKeyRepository, room.id, alice.id, [alice.id, bob.id], newKeyId());
    const aliceUpload = await storeAvatar(services, alice.id);
    await services.avatarService.setUserAvatar(alice.id, { url: aliceUpload.url, encryptedAvatar: 'alice-ptr', profileKeyVersion: 1 });
    await services.avatarService.publishProfileKey(alice.id, { roomId: room.id, keyId, envelope: 'alice-env' });

    const current = await services.roomService.getRoomById(room.id);
    if (!current) {
      throw new Error('room missing');
    }
    const summary = await services.roomService.buildSummary(current, bob.id);

    expect(summary.encryptedAvatar).toBeNull();
    expect(summary.participants).toContainEqual(
      expect.objectContaining({ id: alice.id, encryptedAvatar: 'alice-ptr', profileKeyVersion: 1, profileKeyEnvelope: { envelope: 'alice-env', keyId } }),
    );
  });
});

describe('orphan upload sweeper and avatars', () => {
  async function age(services: Services, key: string): Promise<void> {
    await services.db
      .update(uploads)
      .set({ createdAt: new Date(Date.now() - ORPHAN_UPLOAD_MAX_AGE_MS - 60_000).toISOString() })
      .where(eq(uploads.key, key));
  }

  it('keeps avatars in use and removes avatar uploads never used', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const bob = await createUser(services, 'Bob');
    const { roomId, keyId } = await groupWith(services, alice.id, [bob.id]);
    const userAvatar = await storeAvatar(services, alice.id, 10);
    const roomAvatar = await storeAvatar(services, bob.id, 10);
    const unused = await storeAvatar(services, alice.id, 10);
    const fresh = await storeAvatar(services, alice.id, 10);
    await services.avatarService.setUserAvatar(alice.id, { url: userAvatar.url, encryptedAvatar: POINTER, profileKeyVersion: 1 });
    await services.avatarService.setRoomAvatar(bob.id, { roomId, url: roomAvatar.url, encryptedAvatar: POINTER, keyId });
    for (const key of [userAvatar.key, roomAvatar.key, unused.key]) {
      await age(services, key);
    }

    const sweeper = new OrphanUploadSweeper(services.uploadRegistry, services.objectStorage, services.storageQuota);
    await expect(sweeper.sweep()).resolves.toBe(1);

    await expect(services.uploadRegistry.find(unused.key)).resolves.toBeNull();
    await expect(services.objectStorage.getObject(unused.key)).resolves.toBeNull();
    for (const key of [userAvatar.key, roomAvatar.key, fresh.key]) {
      await expect(services.uploadRegistry.find(key)).resolves.not.toBeNull();
      await expect(services.objectStorage.getObject(key)).resolves.not.toBeNull();
    }
    expect(await services.storageUsageRepository.getBytesUsed()).toBe(30);
  });

  it('removes the avatar object of a deleted account or room and of a group left empty', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const bob = await createUser(services, 'Bob');
    const { roomId, keyId } = await groupWith(services, alice.id, []);
    const second = await groupWith(services, bob.id, []);
    const aliceAvatar = await storeAvatar(services, alice.id, 10);
    const roomAvatar = await storeAvatar(services, alice.id, 10);
    const emptiedAvatar = await storeAvatar(services, bob.id, 10);
    await services.avatarService.setUserAvatar(alice.id, { url: aliceAvatar.url, encryptedAvatar: POINTER, profileKeyVersion: 1 });
    await services.avatarService.setRoomAvatar(alice.id, { roomId, url: roomAvatar.url, encryptedAvatar: POINTER, keyId });
    await services.avatarService.setRoomAvatar(bob.id, { roomId: second.roomId, url: emptiedAvatar.url, encryptedAvatar: POINTER, keyId: second.keyId });
    const sweeper = new OrphanUploadSweeper(services.uploadRegistry, services.objectStorage, services.storageQuota);
    await expect(sweeper.sweep()).resolves.toBe(0);

    await services.db.delete(rooms).where(eq(rooms.id, roomId));
    await services.db.delete(users).where(eq(users.id, alice.id));
    await services.roomService.leaveGroup(second.roomId, bob.id);

    await expect(sweeper.sweep()).resolves.toBe(3);
    for (const key of [aliceAvatar.key, roomAvatar.key, emptiedAvatar.key]) {
      await expect(services.uploadRegistry.find(key)).resolves.toBeNull();
      await expect(services.objectStorage.getObject(key)).resolves.toBeNull();
    }
    expect(await services.storageUsageRepository.getBytesUsed()).toBe(0);
  });
});
