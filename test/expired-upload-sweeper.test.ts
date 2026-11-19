import { describe, expect, it } from 'vitest';
import { GIF_UPLOAD_TTL_MS } from '@/modules/messages/message.upload.js';
import { EXPIRED_UPLOAD_SWEEP_LIMITS, ExpiredUploadSweeper } from '@/storage/expired-upload-sweeper.js';
import type { ObjectStorage } from '@/storage/object-storage.js';
import { ORPHAN_UPLOAD_MAX_AGE_MS, OrphanUploadSweeper } from '@/storage/orphan-upload-sweeper.js';
import { buildRoomService } from './support/build-room-service.js';
import { TEST_V2_SIGNUP } from './support/test-constants.js';

type Services = Awaited<ReturnType<typeof buildRoomService>>;

async function createUser(services: Services, nickname: string) {
  const { user } = await services.userService.registerAccount({
    nickname,
    avatar: 0,
    password: 'correct-horse-battery-staple-0123456789abcd',
    ...TEST_V2_SIGNUP,
  });
  return user;
}

async function storeGif(services: Services, uploaderId: string, key: string, body: Buffer, expiresAt: string): Promise<string> {
  await services.objectStorage.putObject(key, body, { contentType: 'application/octet-stream' });
  await services.uploadRegistry.register(key, uploaderId, body.length, { expiresAt });
  await services.storageQuota.recordUsage(body.length);
  return services.objectStorage.publicUrl(key);
}

const inThirtyDays = () => new Date(Date.now() + GIF_UPLOAD_TTL_MS).toISOString();
const afterExpiry = () => Date.now() + GIF_UPLOAD_TTL_MS + 60_000;

describe('ExpiredUploadSweeper', () => {
  it('removes expired uploads whether attached or not, frees the quota and keeps the rest', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const attachedUrl = await storeGif(services, alice.id, 'uploads/gifs/attached.bin', Buffer.from('attached'), inThirtyDays());
    await services.messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: `${attachedUrl}?e2e=1`, type: 'image' });
    await storeGif(services, alice.id, 'uploads/gifs/loose.bin', Buffer.from('loose'), inThirtyDays());
    await storeGif(services, alice.id, 'uploads/gifs/later.bin', Buffer.from('later!'), new Date(afterExpiry() + GIF_UPLOAD_TTL_MS).toISOString());
    await services.objectStorage.putObject('uploads/images/photo.bin', Buffer.from('photo'), { contentType: 'application/octet-stream' });
    await services.uploadRegistry.register('uploads/images/photo.bin', alice.id, 5);
    await services.storageQuota.recordUsage(5);
    const usageBefore = await services.storageUsageRepository.getBytesUsed();

    expect(await new ExpiredUploadSweeper(services.uploadRegistry, services.objectStorage, services.storageQuota).sweep()).toBe(0);

    const later = new ExpiredUploadSweeper(services.uploadRegistry, services.objectStorage, services.storageQuota, afterExpiry);
    expect(await later.sweep()).toBe(2);
    expect(await later.sweep()).toBe(0);

    for (const key of ['uploads/gifs/attached.bin', 'uploads/gifs/loose.bin']) {
      expect(await services.objectStorage.getObject(key)).toBeNull();
      expect(await services.uploadRegistry.find(key)).toBeNull();
    }
    expect(await services.objectStorage.getObject('uploads/gifs/later.bin')).not.toBeNull();
    expect(await services.uploadRegistry.find('uploads/gifs/later.bin')).not.toBeNull();
    expect(await services.objectStorage.getObject('uploads/images/photo.bin')).not.toBeNull();
    expect(await services.storageUsageRepository.getBytesUsed()).toBe(usageBefore - 'attached'.length - 'loose'.length);
  });

  it('keeps sweeping batches of 100 while they come back full', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    for (let index = 0; index < 101; index += 1) {
      await storeGif(services, alice.id, `uploads/gifs/${index}.bin`, Buffer.from('x'), inThirtyDays());
    }
    const sweeper = new ExpiredUploadSweeper(services.uploadRegistry, services.objectStorage, services.storageQuota, afterExpiry);

    expect(await sweeper.sweep()).toBe(101);
    expect(await sweeper.sweep()).toBe(0);
  });

  it('stops after the maximum number of batches in one run', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    for (let index = 0; index < 7; index += 1) {
      await storeGif(services, alice.id, `uploads/gifs/${index}.bin`, Buffer.from('x'), inThirtyDays());
    }
    const sweeper = new ExpiredUploadSweeper(services.uploadRegistry, services.objectStorage, services.storageQuota, afterExpiry, {
      batchSize: 2,
      maxBatches: 3,
    });

    expect(await sweeper.sweep()).toBe(6);
    expect(await sweeper.sweep()).toBe(1);
  });

  it('defaults to at most 20 batches of 100 per run', () => {
    expect(EXPIRED_UPLOAD_SWEEP_LIMITS).toEqual({ batchSize: 100, maxBatches: 20 });
  });

  it('keeps going when one object cannot be deleted', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    await storeGif(services, alice.id, 'uploads/gifs/a.bin', Buffer.from('a'), inThirtyDays());
    await storeGif(services, alice.id, 'uploads/gifs/b.bin', Buffer.from('b'), inThirtyDays());
    const flaky: ObjectStorage = {
      publicUrl: (key) => services.objectStorage.publicUrl(key),
      getObject: (key) => services.objectStorage.getObject(key),
      putObject: (key, body, options) => services.objectStorage.putObject(key, body, options),
      deleteObject: (key) => (key.endsWith('a.bin') ? Promise.reject(new Error('boom')) : services.objectStorage.deleteObject(key)),
    };

    const removed = await new ExpiredUploadSweeper(services.uploadRegistry, flaky, services.storageQuota, afterExpiry).sweep();

    expect(removed).toBe(1);
    expect(await services.objectStorage.getObject('uploads/gifs/b.bin')).toBeNull();
  });
});

describe('gif messages', () => {
  it('accept an owned gif upload as the content of an image message', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const url = await storeGif(services, alice.id, 'uploads/gifs/mine.bin', Buffer.from('gif'), inThirtyDays());

    const message = await services.messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: `${url}?e2e=1`, type: 'image' });

    await expect(services.uploadRegistry.find('uploads/gifs/mine.bin')).resolves.toMatchObject({ messageId: message.id });
  });

  it('reject a gif upload that belongs to someone else', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const mallory = await createUser(services, 'Mallory');
    const url = await storeGif(services, alice.id, 'uploads/gifs/alice.bin', Buffer.from('gif'), inThirtyDays());

    await expect(
      services.messageService.sendMessage({ roomId: 'room-1', senderId: mallory.id, content: url, type: 'image' }),
    ).rejects.toMatchObject({ code: 'message.invalidMedia' });
  });

  it('free the object and the quota when the message is deleted before expiry', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const url = await storeGif(services, alice.id, 'uploads/gifs/bye.bin', Buffer.from('12345'), inThirtyDays());
    const message = await services.messageService.sendMessage({
      roomId: 'room-1',
      senderId: alice.id,
      content: url,
      type: 'image',
      fileMeta: { name: 'gif.webp', mimeType: 'image/webp; sparkchat-gif=1', size: 3 },
    });

    await services.messageService.deleteMessage(message.id, alice.id);

    expect(await services.objectStorage.getObject('uploads/gifs/bye.bin')).toBeNull();
    expect(await services.uploadRegistry.find('uploads/gifs/bye.bin')).toBeNull();
    expect(await services.storageUsageRepository.getBytesUsed()).toBe(0);
  });

  it('do not release the quota a second time when an expired gif message is deleted', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const url = await storeGif(services, alice.id, 'uploads/gifs/old.bin', Buffer.from('12345'), inThirtyDays());
    const message = await services.messageService.sendMessage({
      roomId: 'room-1',
      senderId: alice.id,
      content: url,
      type: 'image',
      fileMeta: { name: 'gif.webp', mimeType: 'image/webp; sparkchat-gif=1', size: 1_000_000 },
    });
    await services.storageQuota.recordUsage(7);
    await new ExpiredUploadSweeper(services.uploadRegistry, services.objectStorage, services.storageQuota, afterExpiry).sweep();
    expect(await services.storageUsageRepository.getBytesUsed()).toBe(7);

    await services.messageService.deleteMessage(message.id, alice.id);

    expect(await services.storageUsageRepository.getBytesUsed()).toBe(7);
  });

  it('are also cleaned by the orphan sweeper when never sent', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    await storeGif(services, alice.id, 'uploads/gifs/unsent.bin', Buffer.from('gif'), inThirtyDays());

    const orphanSweeper = new OrphanUploadSweeper(
      services.uploadRegistry,
      services.objectStorage,
      services.storageQuota,
      () => Date.now() + ORPHAN_UPLOAD_MAX_AGE_MS + 1000,
    );

    expect(await orphanSweeper.sweep()).toBe(1);
    expect(await services.storageUsageRepository.getBytesUsed()).toBe(0);
  });

  it('reject a gif upload anywhere but as the content of an image message', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const imageUrl = await services.storeUpload(alice.id, 'uploads/images/photo.bin');
    const gifUrl = await storeGif(services, alice.id, 'uploads/gifs/misused.bin', Buffer.from('gif'), inThirtyDays());
    const fileMeta = { name: 'x', mimeType: 'application/octet-stream', size: 3 };
    const attempts = [
      { roomId: 'room-1', senderId: alice.id, content: gifUrl, type: 'audio' as const, duration: 1, fileMeta },
      { roomId: 'room-1', senderId: alice.id, content: gifUrl, type: 'file' as const, fileMeta },
      { roomId: 'room-1', senderId: alice.id, content: imageUrl, type: 'image' as const, fileMeta: { ...fileMeta, thumbnailUrl: gifUrl } },
      { roomId: 'room-1', senderId: alice.id, content: 'oi', type: 'text' as const, attachmentUrls: [gifUrl] },
      { roomId: 'room-1', senderId: alice.id, content: imageUrl, type: 'image' as const, attachmentUrls: [gifUrl] },
    ];

    for (const attempt of attempts) {
      await expect(services.messageService.sendMessage(attempt)).rejects.toMatchObject({ code: 'message.invalidMedia' });
    }
    await expect(services.uploadRegistry.find('uploads/gifs/misused.bin')).resolves.toMatchObject({ messageId: null });
    await expect(services.uploadRegistry.find('uploads/images/photo.bin')).resolves.toMatchObject({ messageId: null });
  });

  it('release the quota only once when the sweeper removed the row during deletion', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const url = await storeGif(services, alice.id, 'uploads/gifs/race.bin', Buffer.from('12345'), inThirtyDays());
    const message = await services.messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: url, type: 'image' });
    await services.storageQuota.recordUsage(7);
    const storage = services.objectStorage;
    const originalDelete = storage.deleteObject.bind(storage);
    const sweeperStorage: ObjectStorage = {
      publicUrl: (key) => storage.publicUrl(key),
      getObject: (key) => storage.getObject(key),
      putObject: (key, body, options) => storage.putObject(key, body, options),
      deleteObject: originalDelete,
    };
    const sweeper = new ExpiredUploadSweeper(services.uploadRegistry, sweeperStorage, services.storageQuota, afterExpiry);
    storage.deleteObject = async (key: string) => {
      await sweeper.sweep();
      await originalDelete(key);
    };

    await services.messageService.deleteMessage(message.id, alice.id);

    expect(await services.storageUsageRepository.getBytesUsed()).toBe(7);
  });
});
