import { afterEach, describe, expect, it } from 'vitest';
import type { MessageRateLimiter } from '@/modules/messages/index.js';
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
  it('does not leak a message from another room through replyToMessageId', async () => {
    const h = await start();
    const { alice, room, aliceClient } = await setupPair(h);
    const carol = await h.createAccount('Carol');
    const secretRoom = await h.roomService.createPrivateRoom(carol.user.id, alice.user.id);
    const secret = await h.messageService.sendMessage({ roomId: secretRoom.id, senderId: carol.user.id, content: 'e2e:v1:segredo' });

    const delivered = waitForEvent<MessageEvent>(aliceClient, 'message:new', (event) => event.clientTempId === 'probe');
    aliceClient.emit('message:send', { roomId: room.id, content: 'oi', replyToMessageId: secret.id, clientTempId: 'probe' });

    await expect(delivered).resolves.toMatchObject({ content: 'oi', replyTo: null });
  });

  it('updates the replies of a message deleted for everyone with a deleted snapshot', async () => {
    const h = await start();
    const { room, aliceClient, bobClient } = await setupPair(h);

    const originalEvent = waitForEvent<MessageEvent>(bobClient, 'message:new', (event) => event.clientTempId === 'original');
    aliceClient.emit('message:send', { roomId: room.id, content: 'vou apagar', clientTempId: 'original' });
    const original = await originalEvent;

    const replyEvent = waitForEvent<MessageEvent>(aliceClient, 'message:new', (event) => event.clientTempId === 'reply');
    bobClient.emit('message:send', { roomId: room.id, content: 'respondendo', replyToMessageId: original.id, clientTempId: 'reply' });
    const reply = await replyEvent;
    expect(reply.replyTo).toMatchObject({ id: original.id, content: 'vou apagar', deleted: false });

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
    const group = await h.roomService.createGroupRoom('Amigos', alice.user.id);
    await h.roomService.joinByCode(group.roomCode ?? '', bob.user.id);
    const original = await h.messageService.sendMessage({ roomId: group.id, senderId: alice.user.id, content: 'e2e:v1:antigo' });
    const reply = await h.messageService.sendMessage({
      roomId: group.id,
      senderId: bob.user.id,
      content: 'e2e:v1:resposta',
      replyToMessageId: original.id,
    });
    await settle(20);
    await h.roomService.joinByCode(group.roomCode ?? '', carol.user.id);

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
      content: 'https://cdn.test/uploads/audio/a.webm',
      type: 'audio',
      duration: 3,
    });

    malloryClient.emit('audio:played', { messageId: audio.id });
    await settle(150);

    expect((await h.messageService.getMessage(audio.id))?.playedBy).toEqual([]);
  });
});
