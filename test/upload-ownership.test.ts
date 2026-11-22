import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadDecryptedAttachment } from '@/modules/ai/ai.attachments.js';
import { MAX_USER_STORAGE_BYTES } from '@/modules/messages/message.controller.js';
import { InMemoryObjectStorage } from '@/storage/object-storage.js';
import { ORPHAN_UPLOAD_MAX_AGE_MS, OrphanUploadSweeper } from '@/storage/orphan-upload-sweeper.js';
import { buildRoomService } from './support/build-room-service.js';
import { buildTestApp } from './support/build-test-app.js';
import { TEST_V2_SIGNUP } from './support/test-constants.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function createUser(services: Awaited<ReturnType<typeof buildRoomService>>, nickname: string) {
  const { user } = await services.userService.registerAccount({ nickname, avatar: 0, password: 'correct-horse-battery-staple-0123456789abcd', ...TEST_V2_SIGNUP });
  return user;
}

describe('upload registration', () => {
  it('records who uploaded each file and how big it is', async () => {
    const { app, userService, uploadRegistry } = await buildTestApp();
    const { user, sessionToken } = await userService.registerAccount({ nickname: 'Uploader', avatar: 0, password: 'correct-horse-battery-staple-0123456789abcd', ...TEST_V2_SIGNUP });

    const response = await request(app)
      .post('/api/messages/upload-image')
      .set('Authorization', `Bearer ${user.id}:${sessionToken}`)
      .attach('image', PNG_BYTES, { filename: 'photo.png', contentType: 'image/png' });

    expect(response.status).toBe(201);
    const { url } = response.body as { url: string };
    const key = new URL(url).pathname.slice(1);
    await expect(uploadRegistry.find(key)).resolves.toMatchObject({ uploaderId: user.id, size: PNG_BYTES.length, messageId: null });
  });

  it('refuses uploads beyond the per-user storage limit', async () => {
    const { app, userService, uploadRegistry } = await buildTestApp();
    const { user, sessionToken } = await userService.registerAccount({ nickname: 'Hoarder', avatar: 0, password: 'correct-horse-battery-staple-0123456789abcd', ...TEST_V2_SIGNUP });
    await uploadRegistry.register('uploads/files/big.bin', user.id, MAX_USER_STORAGE_BYTES - 4);

    const response = await request(app)
      .post('/api/messages/upload-image')
      .set('Authorization', `Bearer ${user.id}:${sessionToken}`)
      .attach('image', PNG_BYTES, { filename: 'photo.png', contentType: 'image/png' });

    expect(response.status).toBe(507);
    expect(response.body).toMatchObject({ code: 'upload.newAccountQuotaExceeded' });
  });
});

describe('media messages only accept the sender’s own unused uploads', () => {
  it('accepts a file the sender uploaded and attaches it to the message', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const url = await services.storeUpload(alice.id, 'uploads/images/mine.png');

    const message = await services.messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: `${url}?e2e=1`, type: 'image' });

    await expect(services.uploadRegistry.find('uploads/images/mine.png')).resolves.toMatchObject({ messageId: message.id });
  });

  it('rejects a file uploaded by someone else', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const mallory = await createUser(services, 'Mallory');
    const url = await services.storeUpload(alice.id, 'uploads/files/alice.pdf');

    await expect(
      services.messageService.sendMessage({
        roomId: 'room-1',
        senderId: mallory.id,
        content: url,
        type: 'file',
        fileMeta: { name: 'x.pdf', mimeType: 'application/pdf', size: 10 },
      }),
    ).rejects.toMatchObject({ code: 'message.invalidMedia' });
  });

  it('rejects a file that is already attached to another message', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const url = await services.storeUpload(alice.id, 'uploads/audio/clip.webm');
    await services.messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: url, type: 'audio', duration: 3 });

    await expect(
      services.messageService.sendMessage({ roomId: 'room-2', senderId: alice.id, content: url, type: 'audio', duration: 3 }),
    ).rejects.toMatchObject({ code: 'message.invalidMedia' });
  });

  it('rejects a lookalike path on another host and an upload that was never registered', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    await services.storeUpload(alice.id, 'uploads/images/real.png');

    await expect(
      services.messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'https://evil.example/uploads/images/real.png', type: 'image' }),
    ).rejects.toMatchObject({ code: 'message.invalidMedia' });
    await expect(
      services.messageService.sendMessage({
        roomId: 'room-1',
        senderId: alice.id,
        content: services.objectStorage.publicUrl('uploads/images/ghost.png'),
        type: 'image',
      }),
    ).rejects.toMatchObject({ code: 'message.invalidMedia' });
  });

  it('rejects a thumbnail that belongs to someone else and leaves the main upload free', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const bob = await createUser(services, 'Bob');
    const url = await services.storeUpload(alice.id, 'uploads/files/video.mp4');
    const thumbnailUrl = await services.storeUpload(bob.id, 'uploads/images/bob-thumb.webp');

    await expect(
      services.messageService.sendMessage({
        roomId: 'room-1',
        senderId: alice.id,
        content: url,
        type: 'file',
        fileMeta: { name: 'video.mp4', mimeType: 'video/mp4', size: 10, thumbnailUrl },
      }),
    ).rejects.toMatchObject({ code: 'message.invalidMedia' });
    await expect(services.uploadRegistry.find('uploads/files/video.mp4')).resolves.toMatchObject({ messageId: null });
  });
});

describe('extra attachments such as link preview images', () => {
  it('attaches the sender’s preview image to a text message and removes it with the message', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const imageUrl = await services.storeUpload(alice.id, 'uploads/images/preview.bin', Buffer.from('1234'));
    await services.storageQuota.recordUsage(4);

    const message = await services.messageService.sendMessage({
      roomId: 'room-1',
      senderId: alice.id,
      content: 'e2e:v1:texto',
      attachmentUrls: [`${imageUrl}?e2e=1`],
    });
    await expect(services.uploadRegistry.find('uploads/images/preview.bin')).resolves.toMatchObject({ messageId: message.id });

    await services.messageService.deleteMessage(message.id, alice.id);

    expect(await services.objectStorage.getObject('uploads/images/preview.bin')).toBeNull();
    expect(await services.uploadRegistry.find('uploads/images/preview.bin')).toBeNull();
    expect(await services.storageUsageRepository.getBytesUsed()).toBe(0);
  });

  it('rejects an extra attachment uploaded by someone else', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const mallory = await createUser(services, 'Mallory');
    const imageUrl = await services.storeUpload(alice.id, 'uploads/images/alice-preview.bin');

    await expect(
      services.messageService.sendMessage({ roomId: 'room-1', senderId: mallory.id, content: 'e2e:v1:x', attachmentUrls: [imageUrl] }),
    ).rejects.toMatchObject({ code: 'message.invalidMedia' });
  });
});

describe('deleting media messages', () => {
  it('releases the recorded size instead of the size the client claimed', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const url = await services.storeUpload(alice.id, 'uploads/files/doc.pdf', Buffer.from('12345'));
    await services.storageQuota.recordUsage(5);

    const message = await services.messageService.sendMessage({
      roomId: 'room-1',
      senderId: alice.id,
      content: url,
      type: 'file',
      fileMeta: { name: 'doc.pdf', mimeType: 'application/pdf', size: 9_000_000_000_000 },
    });
    await services.messageService.deleteMessage(message.id, alice.id);

    expect(await services.storageUsageRepository.getBytesUsed()).toBe(0);
    expect(await services.objectStorage.getObject('uploads/files/doc.pdf')).toBeNull();
    expect(await services.uploadRegistry.find('uploads/files/doc.pdf')).toBeNull();
  });

  it('keeps an object that is attached to a different message', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const mallory = await createUser(services, 'Mallory');
    const url = await services.storeUpload(alice.id, 'uploads/images/victim.png');
    await services.messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: url, type: 'image' });
    const forged = await services.messageRepository.insert({
      id: 'forged-message',
      roomId: 'room-2',
      senderId: mallory.id,
      content: url,
      type: 'image',
      duration: null,
      timestamp: new Date().toISOString(),
      deletedForEveryone: false,
      status: 'sent',
      deliveredTo: [],
      readBy: [],
      playedBy: [],
      replyTo: null,
      mentionedUserIds: [],
      fileMeta: null,
      caption: null,
      linkPreview: null,
      systemEvent: null,
    });

    await services.messageService.deleteMessage(forged.id, mallory.id);

    expect(await services.objectStorage.getObject('uploads/images/victim.png')).not.toBeNull();
  });
});

describe('orphan upload sweeper', () => {
  it('removes uploads never attached to a message after a day and keeps the rest', async () => {
    const services = await buildRoomService();
    const alice = await createUser(services, 'Alice');
    const attachedUrl = await services.storeUpload(alice.id, 'uploads/images/kept.png');
    await services.messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: attachedUrl, type: 'image' });
    await services.storeUpload(alice.id, 'uploads/images/orphan.png', Buffer.from('orphan'));
    await services.storageQuota.recordUsage(6);

    const fresh = new OrphanUploadSweeper(services.uploadRegistry, services.objectStorage, services.storageQuota);
    expect(await fresh.sweep()).toBe(0);

    const later = new OrphanUploadSweeper(
      services.uploadRegistry,
      services.objectStorage,
      services.storageQuota,
      () => Date.now() + ORPHAN_UPLOAD_MAX_AGE_MS + 1000,
    );
    expect(await later.sweep()).toBe(1);

    expect(await services.objectStorage.getObject('uploads/images/orphan.png')).toBeNull();
    expect(await services.uploadRegistry.find('uploads/images/orphan.png')).toBeNull();
    expect(await services.objectStorage.getObject('uploads/images/kept.png')).not.toBeNull();
    expect(await services.storageUsageRepository.getBytesUsed()).toBe(0);
  });
});

describe('assistant attachment limits', () => {
  it('refuses to load an attachment bigger than the allowed size', async () => {
    const objectStorage = new InMemoryObjectStorage();
    await objectStorage.putObject('uploads/files/huge.txt', Buffer.alloc(4096), { contentType: 'text/plain' });

    const result = await loadDecryptedAttachment(
      objectStorage.publicUrl('uploads/files/huge.txt'),
      { roomId: 'room', messageId: 'message', slot: 'content' },
      Buffer.alloc(32, 1).toString('base64url'),
      objectStorage,
      1024,
    );

    expect(result).toBeNull();
  });
});
