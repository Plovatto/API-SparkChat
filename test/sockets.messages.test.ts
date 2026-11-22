import { afterEach, describe, expect, it } from 'vitest';
import type { MessageRateLimiter } from '@/modules/messages/index.js';
import { randomUUID } from 'node:crypto';
import { fakeField, newKeyId, TEST_KEY_ID } from './support/room-keys.js';
import { collectEvents, settle, startSocketHarness, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

interface ErrorEvent {
  code: string;
  clientTempId?: string;
  event?: string;
  params?: Record<string, unknown>;
}

interface MessageEvent {
  id: string;
  content: string;
  clientTempId?: string;
  replyTo: { id: string; content: string; deleted: boolean } | null;
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

async function setupPair(h: Harness) {
  const alice = await h.createAccount('Alice');
  const bob = await h.createAccount('Bob');
  const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
  await h.roomService.createPrivateRoom(bob.user.id, alice.user.id);
  await h.establishRoomKey(room.id);
  const aliceClient = await h.connectAs(alice);
  const bobClient = await h.connectAs(bob);
  await Promise.all([joinVisibleRooms(aliceClient), joinVisibleRooms(bobClient)]);
  return { alice, bob, room, aliceClient, bobClient };
}

describe('message:send errors', () => {
  it('returns the clientTempId with the rate limit error', async () => {
    const blockedLimiter = { isBlocked: () => true, registerSend: () => undefined } as unknown as MessageRateLimiter;
    const h = await start({ messageRateLimiter: blockedLimiter });
    const { room, aliceClient } = await setupPair(h);

    const error = waitForEvent<ErrorEvent>(aliceClient, 'error');
    aliceClient.emit('message:send', { roomId: room.id, content: 'rápido demais', clientTempId: 'temp-1' });

    await expect(error).resolves.toMatchObject({ code: 'rateLimit.messages', clientTempId: 'temp-1' });
  });

  it('returns the clientTempId when the payload fails validation', async () => {
    const h = await start();
    const { room, aliceClient } = await setupPair(h);

    const error = waitForEvent<ErrorEvent>(aliceClient, 'error');
    aliceClient.emit('message:send', { roomId: room.id, content: 'x'.repeat(30001), clientTempId: 'temp-2' });

    await expect(error).resolves.toMatchObject({ code: 'validation.invalidPayload', clientTempId: 'temp-2' });
  });

  it('returns the clientTempId when the socket is not authenticated', async () => {
    const h = await start();
    const anonymous = await h.connect();

    const error = waitForEvent<ErrorEvent>(anonymous, 'error');
    anonymous.emit('message:send', { roomId: 'whatever', content: 'oi', clientTempId: 'temp-3' });

    await expect(error).resolves.toMatchObject({ code: 'auth.unauthenticated', clientTempId: 'temp-3' });
  });
});

describe('replies over sockets', () => {
  it('uses the client supplied messageId and rejects a duplicate or malformed one', async () => {
    const h = await start();
    const { room, aliceClient } = await setupPair(h);
    const messageId = '6f1d9c1e-2b1a-4f57-9d0e-5f3f0a1b2c3d';

    const first = waitForEvent<MessageEvent>(aliceClient, 'message:new', (event) => event.clientTempId === 'own-1');
    aliceClient.emit('message:send', { roomId: room.id, content: fakeField('hi'), messageId, clientTempId: 'own-1' });
    await expect(first).resolves.toMatchObject({ id: messageId });

    const duplicate = waitForEvent<ErrorEvent>(aliceClient, 'error', (event) => event.clientTempId === 'own-2');
    aliceClient.emit('message:send', { roomId: room.id, content: fakeField('again'), messageId, clientTempId: 'own-2' });
    await expect(duplicate).resolves.toMatchObject({ clientTempId: 'own-2', code: 'message.invalidMedia' });
    expect((await h.messageService.getMessage(messageId))?.content).toBe(fakeField('hi'));

    const malformed = waitForEvent<ErrorEvent>(aliceClient, 'error', (event) => event.clientTempId === 'own-3');
    aliceClient.emit('message:send', { roomId: room.id, content: 'x', messageId: 'not-a-uuid', clientTempId: 'own-3' });
    await expect(malformed).resolves.toMatchObject({ clientTempId: 'own-3' });
  });

  it('rejects an id that belongs to a message of another user and room', async () => {
    const h = await start();
    const { room, aliceClient } = await setupPair(h);
    const carol = await h.createAccount('Carol');
    const dave = await h.createAccount('Dave');
    const otherRoom = await h.roomService.createPrivateRoom(carol.user.id, dave.user.id);
    const foreign = await h.messageService.sendMessage({ roomId: otherRoom.id, senderId: carol.user.id, content: 'private' });

    const rejected = waitForEvent<ErrorEvent>(aliceClient, 'error', (event) => event.clientTempId === 'steal');
    aliceClient.emit('message:send', { roomId: room.id, content: fakeField('x'), messageId: foreign.id, clientTempId: 'steal' });
    await expect(rejected).resolves.toMatchObject({ clientTempId: 'steal' });
    expect((await h.messageService.getMessage(foreign.id))?.roomId).toBe(otherRoom.id);
  });

  it('does not leak a message from another room through replyToMessageId', async () => {
    const h = await start();
    const { alice, room, aliceClient } = await setupPair(h);
    const carol = await h.createAccount('Carol');
    const secretRoom = await h.roomService.createPrivateRoom(carol.user.id, alice.user.id);
    const secret = await h.messageService.sendMessage({ roomId: secretRoom.id, senderId: carol.user.id, content: 'e2e:v1:segredo' });

    const delivered = waitForEvent<MessageEvent>(aliceClient, 'message:new', (event) => event.clientTempId === 'probe');
    aliceClient.emit('message:send', { roomId: room.id, content: fakeField('oi'), messageId: randomUUID(), replyToMessageId: secret.id, clientTempId: 'probe' });

    await expect(delivered).resolves.toMatchObject({ content: fakeField('oi'), replyTo: null });
  });

  it('updates the replies of a message deleted for everyone with a deleted snapshot', async () => {
    const h = await start();
    const { room, aliceClient, bobClient } = await setupPair(h);

    const originalEvent = waitForEvent<MessageEvent>(bobClient, 'message:new', (event) => event.clientTempId === 'original');
    aliceClient.emit('message:send', { roomId: room.id, content: fakeField('vou apagar'), messageId: randomUUID(), clientTempId: 'original' });
    const original = await originalEvent;

    const replyEvent = waitForEvent<MessageEvent>(aliceClient, 'message:new', (event) => event.clientTempId === 'reply');
    bobClient.emit('message:send', { roomId: room.id, content: fakeField('respondendo'), messageId: randomUUID(), replyToMessageId: original.id, clientTempId: 'reply' });
    const reply = await replyEvent;
    expect(reply.replyTo).toMatchObject({ id: original.id, content: fakeField('vou apagar'), deleted: false });

    const updated = waitForEvent<MessageEvent>(bobClient, 'message:updated', (event) => event.id === reply.id);
    const deleted = waitForEvent(bobClient, 'message:deleted');
    aliceClient.emit('message:delete', { messageId: original.id });
    await deleted;

    await expect(updated).resolves.toMatchObject({ replyTo: { id: original.id, content: '', deleted: true } });
  });

  it('only sends the updated replies to group members whose history includes them', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const carol = await h.createAccount('Carol');
    const group = await h.roomService.createGroupRoom(alice.user.id);
    await h.joinGroup(group.id, bob.user.id);
    await settle(5);
    const original = await h.messageService.sendMessage({ roomId: group.id, senderId: alice.user.id, content: 'e2e:v1:antigo' });
    const reply = await h.messageService.sendMessage({
      roomId: group.id,
      senderId: bob.user.id,
      content: 'e2e:v1:resposta',
      replyToMessageId: original.id,
    });
    await settle(20);
    await h.joinGroup(group.id, carol.user.id);

    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const carolClient = await h.connectAs(carol);
    await Promise.all([joinVisibleRooms(aliceClient), joinVisibleRooms(bobClient), joinVisibleRooms(carolClient)]);
    const carolUpdates = collectEvents<MessageEvent>(carolClient, 'message:updated');

    const bobUpdated = waitForEvent<MessageEvent>(bobClient, 'message:updated', (event) => event.id === reply.id);
    const carolDeleted = waitForEvent(carolClient, 'message:deleted');
    aliceClient.emit('message:delete', { messageId: original.id });

    await expect(bobUpdated).resolves.toMatchObject({ replyTo: { id: original.id, deleted: true } });
    await carolDeleted;
    await settle(100);
    expect(carolUpdates.filter((event) => event.id === reply.id)).toHaveLength(0);
  });
});

describe('room authorization for activity and receipts', () => {
  it('ignores typing for a room the socket is not subscribed to', async () => {
    const h = await start();
    const { room, bobClient } = await setupPair(h);
    const mallory = await h.createAccount('Mallory');
    const malloryClient = await h.connectAs(mallory);
    const typing = collectEvents(bobClient, 'typing:update');

    malloryClient.emit('typing:start', { roomId: room.id });
    malloryClient.emit('typing:start', { roomId: `user:${mallory.user.id}` });
    await settle(150);

    expect(typing).toHaveLength(0);
    expect(h.typingService.startTyping(room.id, 'probe')).toEqual(['probe']);
  });

  it('rejects mark-read from a user who is not a participant', async () => {
    const h = await start();
    const { room, aliceClient, bobClient } = await setupPair(h);
    const mallory = await h.createAccount('Mallory');
    const malloryClient = await h.connectAs(mallory);
    const receipts = [...collectEvents(aliceClient, 'message:read-receipt'), ...collectEvents(bobClient, 'message:read-receipt')];

    const error = waitForEvent<ErrorEvent>(malloryClient, 'error');
    malloryClient.emit('message:mark-read', { roomId: room.id });

    await expect(error).resolves.toMatchObject({ code: 'room.notFound' });
    await settle(50);
    expect(receipts).toHaveLength(0);
  });

  it('does not let an outsider mark an audio message as played', async () => {
    const h = await start();
    const { alice, room } = await setupPair(h);
    const mallory = await h.createAccount('Mallory');
    const malloryClient = await h.connectAs(mallory);
    const audio = await h.messageService.sendMessage({
      roomId: room.id,
      senderId: alice.user.id,
      content: await h.storeUpload(alice.user.id, 'uploads/audio/a.webm'),
      type: 'audio',
      duration: 3,
    });

    malloryClient.emit('audio:played', { messageId: audio.id });
    await settle(150);

    expect((await h.messageService.getMessage(audio.id))?.playedBy).toEqual([]);
  });
});

describe('message:send accepts only v2 encrypted fields bound to the current room key', () => {
  async function expectRejected(client: TestClient, payload: Record<string, unknown>, code: string): Promise<void> {
    const clientTempId = randomUUID();
    const error = waitForEvent<ErrorEvent>(client, 'error', (event) => event.clientTempId === clientTempId);
    client.emit('message:send', { messageId: randomUUID(), ...payload, clientTempId });
    await expect(error).resolves.toMatchObject({ code });
  }

  it('rejects legacy v1, plaintext, truncated and mixed key content', async () => {
    const h = await start();
    const { room, aliceClient } = await setupPair(h);
    const v1 = `e2e:v1:${Buffer.alloc(80).toString('base64')}`;

    await expectRejected(aliceClient, { roomId: room.id, content: v1 }, 'message.unsupportedEncryption');
    await expectRejected(aliceClient, { roomId: room.id, content: 'olá em texto puro' }, 'message.unsupportedEncryption');
    await expectRejected(aliceClient, { roomId: room.id, content: `e2e:v2:${TEST_KEY_ID}:${Buffer.alloc(40).toString('base64url')}` }, 'message.unsupportedEncryption');
    await expectRejected(aliceClient, { roomId: room.id, content: `e2e:v2:${Buffer.alloc(120).toString('base64url')}` }, 'message.unsupportedEncryption');
    await expectRejected(
      aliceClient,
      { roomId: room.id, content: fakeField('oi'), linkPreview: { url: fakeField('u', newKeyId()), title: fakeField('t'), description: null, imageUrl: null, siteName: null } },
      'message.unsupportedEncryption',
    );
    expect((await h.messageService.getRoomMessagesPage(room.id, { limit: 10 })).messages).toHaveLength(0);
  });

  it('rejects a v1 caption or file name on an attachment and requires file metadata for attachments', async () => {
    const h = await start();
    const { alice, room, aliceClient } = await setupPair(h);
    const url = await h.storeUpload(alice.user.id, 'uploads/images/a.bin');
    const fileMeta = { name: fakeField('a.png'), mimeType: fakeField('image/png'), size: 10, key: fakeField('k'.repeat(43)) };

    await expectRejected(aliceClient, { roomId: room.id, type: 'image', content: url, fileMeta, caption: 'e2e:v1:legenda' }, 'message.unsupportedEncryption');
    await expectRejected(aliceClient, { roomId: room.id, type: 'image', content: url, fileMeta: { ...fileMeta, name: 'e2e:v1:nome' } }, 'message.unsupportedEncryption');
    await expectRejected(aliceClient, { roomId: room.id, type: 'image', content: url }, 'validation.invalidPayload');

    const delivered = waitForEvent<MessageEvent>(aliceClient, 'message:new');
    aliceClient.emit('message:send', { roomId: room.id, type: 'image', content: url, fileMeta, caption: fakeField('legenda'), messageId: randomUUID() });
    await expect(delivered).resolves.toMatchObject({ content: url });
  });

  it('accepts per-attachment keys sealed as v2 fields and stores them without reading them', async () => {
    const h = await start();
    const { alice, room, aliceClient } = await setupPair(h);
    const url = await h.storeUpload(alice.user.id, 'uploads/images/k.bin');
    const thumbnailUrl = await h.storeUpload(alice.user.id, 'uploads/images/k-thumb.bin');
    const fileMeta = {
      name: fakeField('a.png'),
      mimeType: fakeField('image/png'),
      size: 10,
      thumbnailUrl,
      key: fakeField('k'.repeat(43)),
      thumbnailKey: fakeField('t'.repeat(43)),
    };

    const delivered = waitForEvent<MessageEvent & { id: string; fileMeta: Record<string, unknown> }>(aliceClient, 'message:new');
    aliceClient.emit('message:send', { roomId: room.id, type: 'image', content: url, fileMeta, messageId: randomUUID() });
    const view = await delivered;

    expect(view.fileMeta).toEqual(fileMeta);
    expect((await h.messageService.getMessage(view.id))?.fileMeta).toEqual(fileMeta);
  });

  it('accepts a link preview image key on a text message', async () => {
    const h = await start();
    const { room, aliceClient } = await setupPair(h);
    const fileMeta = { name: fakeField('link-preview'), mimeType: fakeField('image/webp'), size: 1, previewKey: fakeField('p'.repeat(43)) };
    const linkPreview = { url: fakeField('u'), title: fakeField('t'), description: null, imageUrl: fakeField('i'), siteName: null };

    const delivered = waitForEvent<MessageEvent & { fileMeta: Record<string, unknown> }>(aliceClient, 'message:new');
    aliceClient.emit('message:send', { roomId: room.id, content: fakeField('veja'), fileMeta, linkPreview, messageId: randomUUID() });

    await expect(delivered).resolves.toMatchObject({ fileMeta: { previewKey: fileMeta.previewKey } });
  });

  it('rejects an attachment key that is not sealed as a v2 field of the current generation', async () => {
    const h = await start();
    const { alice, room, aliceClient } = await setupPair(h);
    const url = await h.storeUpload(alice.user.id, 'uploads/images/p.bin');
    const fileMeta = { name: fakeField('a.png'), mimeType: fakeField('image/png'), size: 10, key: fakeField('k'.repeat(43)) };
    const rawKey = Buffer.alloc(32, 1).toString('base64url');

    await expectRejected(aliceClient, { roomId: room.id, type: 'image', content: url, fileMeta: { ...fileMeta, key: rawKey } }, 'message.unsupportedEncryption');
    await expectRejected(
      aliceClient,
      { roomId: room.id, type: 'image', content: url, fileMeta: { ...fileMeta, thumbnailUrl: url, thumbnailKey: fakeField('t'.repeat(43), newKeyId()) } },
      'message.unsupportedEncryption',
    );
    await expectRejected(
      aliceClient,
      { roomId: room.id, content: fakeField('oi'), fileMeta: { name: fileMeta.name, mimeType: fileMeta.mimeType, size: 1, previewKey: rawKey } },
      'message.unsupportedEncryption',
    );
    await expectRejected(aliceClient, { roomId: room.id, type: 'image', content: url, fileMeta: { ...fileMeta, key: 'x'.repeat(401) } }, 'validation.invalidPayload');
    expect((await h.messageService.getRoomMessagesPage(room.id, { limit: 10 })).messages).toHaveLength(0);
  });

  it('requires the attachment key, the thumbnail key and the link preview key where they apply', async () => {
    const h = await start();
    const { alice, room, aliceClient } = await setupPair(h);
    const url = await h.storeUpload(alice.user.id, 'uploads/files/r.bin');
    const thumbnailUrl = await h.storeUpload(alice.user.id, 'uploads/images/r-thumb.bin');
    const base = { name: fakeField('r.bin'), mimeType: fakeField('application/octet-stream'), size: 10 };
    const key = fakeField('k'.repeat(43));

    for (const type of ['image', 'audio', 'file'] as const) {
      await expectRejected(aliceClient, { roomId: room.id, type, content: url, duration: 3, fileMeta: base }, 'message.attachmentKeyRequired');
    }
    await expectRejected(aliceClient, { roomId: room.id, type: 'image', content: url, fileMeta: { ...base, key, thumbnailUrl } }, 'message.attachmentKeyRequired');
    await expectRejected(
      aliceClient,
      { roomId: room.id, content: fakeField('veja'), fileMeta: { name: fakeField('link-preview'), mimeType: fakeField('image/webp'), size: 1 } },
      'message.attachmentKeyRequired',
    );
    expect((await h.messageService.getRoomMessagesPage(room.id, { limit: 10 })).messages).toHaveLength(0);

    const delivered = waitForEvent<MessageEvent>(aliceClient, 'message:new');
    aliceClient.emit('message:send', { roomId: room.id, type: 'audio', content: url, duration: 3, fileMeta: { ...base, key }, messageId: randomUUID() });
    await expect(delivered).resolves.toMatchObject({ content: url });
  });

  it('requires a preview key for a link preview image even without fileMeta', async () => {
    const h = await start();
    const { room, aliceClient } = await setupPair(h);
    const linkPreview = { url: fakeField('u'), title: fakeField('t'), description: null, imageUrl: fakeField('i'), siteName: null };

    await expectRejected(aliceClient, { roomId: room.id, content: fakeField('veja'), linkPreview }, 'message.attachmentKeyRequired');

    const delivered = waitForEvent<MessageEvent>(aliceClient, 'message:new');
    aliceClient.emit('message:send', { roomId: room.id, content: fakeField('sem imagem'), linkPreview: { ...linkPreview, imageUrl: null }, messageId: randomUUID() });
    await expect(delivered).resolves.toMatchObject({ content: fakeField('sem imagem') });
  });

  it('rejects attachment-only fileMeta fields on a text message', async () => {
    const h = await start();
    const { alice, room, aliceClient } = await setupPair(h);
    const thumbnailUrl = await h.storeUpload(alice.user.id, 'uploads/images/t-thumb.bin');
    const fileMeta = { name: fakeField('link-preview'), mimeType: fakeField('image/webp'), size: 1, previewKey: fakeField('p'.repeat(43)) };
    const content = fakeField('veja');

    await expectRejected(aliceClient, { roomId: room.id, content, fileMeta: { ...fileMeta, key: fakeField('k'.repeat(43)) } }, 'validation.invalidPayload');
    await expectRejected(aliceClient, { roomId: room.id, content, fileMeta: { ...fileMeta, thumbnailKey: fakeField('t'.repeat(43)) } }, 'validation.invalidPayload');
    await expectRejected(aliceClient, { roomId: room.id, content, fileMeta: { ...fileMeta, thumbnailUrl } }, 'validation.invalidPayload');
    expect((await h.messageService.getRoomMessagesPage(room.id, { limit: 10 })).messages).toHaveLength(0);
  });

  it('requires a client message id because the fields are bound to it', async () => {
    const h = await start();
    const { room, aliceClient } = await setupPair(h);
    const error = waitForEvent<ErrorEvent>(aliceClient, 'error', (event) => event.clientTempId === 'no-id');
    aliceClient.emit('message:send', { roomId: room.id, content: fakeField('oi'), clientTempId: 'no-id' });

    await expect(error).resolves.toMatchObject({ code: 'validation.invalidPayload' });
  });

  it('rejects content sealed with a key that is not the current generation, or while a rotation is pending', async () => {
    const h = await start();
    const { room, aliceClient } = await setupPair(h);

    await expectRejected(aliceClient, { roomId: room.id, content: fakeField('velha', newKeyId()) }, 'message.staleRoomKey');

    await h.roomKeyRepository.markRotationRequired(room.id);
    await expectRejected(aliceClient, { roomId: room.id, content: fakeField('durante a rotação') }, 'message.staleRoomKey');

    const keyId = await h.establishRoomKey(room.id);
    await expectRejected(aliceClient, { roomId: room.id, content: fakeField('chave antiga') }, 'message.staleRoomKey');
    const delivered = waitForEvent<MessageEvent>(aliceClient, 'message:new');
    aliceClient.emit('message:send', { roomId: room.id, content: fakeField('chave nova', keyId), messageId: randomUUID() });
    await expect(delivered).resolves.toMatchObject({ content: fakeField('chave nova', keyId) });
  });

  it('rejects messages in a room that has no key generation yet', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    const aliceClient = await h.connectAs(alice);
    await joinVisibleRooms(aliceClient);

    await expectRejected(aliceClient, { roomId: room.id, content: fakeField('cedo demais') }, 'message.staleRoomKey');
  });
});
