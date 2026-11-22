import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { systemEvent } from '@/modules/messages/index.js';
import { fakeField, newKeyId } from './support/room-keys.js';
import { collectEvents, settle, startSocketHarness, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

interface ReactionsEvent {
  roomId: string;
  messageId: string;
  messageTimestamp: string;
  reactions: { userId: string; emoji: string; updatedAt: string }[];
}

interface ErrorEvent {
  code: string;
  event?: string;
  messageId?: string;
}

interface MessageEvent {
  id: string;
  clientTempId?: string;
  reactions: ReactionsEvent['reactions'];
}

let harness: Harness | null = null;

async function start(): Promise<Harness> {
  harness = await startSocketHarness();
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

async function sendFrom(client: TestClient, roomId: string, text: string): Promise<MessageEvent> {
  const clientTempId = randomUUID();
  const delivered = waitForEvent<MessageEvent>(client, 'message:new', (event) => event.clientTempId === clientTempId);
  client.emit('message:send', { roomId, content: fakeField(text), messageId: randomUUID(), clientTempId });
  return delivered;
}

function reactionFor(client: TestClient, messageId: string): Promise<ReactionsEvent> {
  return waitForEvent<ReactionsEvent>(client, 'message:reactions-updated', (event) => event.messageId === messageId);
}

function reactionErrorFor(client: TestClient, messageId: string): Promise<ErrorEvent> {
  return waitForEvent<ErrorEvent>(client, 'error', (event) => event.event === 'message:react' && event.messageId === messageId);
}

describe('message:react', () => {
  it('stores one encrypted reaction per person and broadcasts it to every device in the room', async () => {
    const h = await start();
    const { alice, bob, room, aliceClient, bobClient } = await setupPair(h);
    const aliceLaptop = await h.connectAs(alice);
    await joinVisibleRooms(aliceLaptop);
    const message = await sendFrom(bobClient, room.id, 'oi');
    expect(message.reactions).toEqual([]);

    const heart = fakeField('heart');
    const bobSaw = reactionFor(bobClient, message.id);
    const laptopSaw = reactionFor(aliceLaptop, message.id);
    aliceClient.emit('message:react', { messageId: message.id, emoji: heart });

    const stored = await h.messageService.getMessage(message.id);
    await expect(bobSaw).resolves.toMatchObject({
      roomId: room.id,
      messageId: message.id,
      messageTimestamp: stored?.timestamp,
      reactions: [{ userId: alice.user.id, emoji: heart }],
    });
    await expect(laptopSaw).resolves.toMatchObject({ reactions: [{ userId: alice.user.id, emoji: heart }] });

    const laugh = fakeField('laugh');
    const changed = reactionFor(bobClient, message.id);
    aliceClient.emit('message:react', { messageId: message.id, emoji: laugh });
    await expect(changed).resolves.toMatchObject({ reactions: [{ userId: alice.user.id, emoji: laugh }] });

    const bobReacted = reactionFor(aliceClient, message.id);
    bobClient.emit('message:react', { messageId: message.id, emoji: heart });
    const both = await bobReacted;
    expect(both.reactions.map((reaction) => reaction.userId)).toEqual([alice.user.id, bob.user.id]);

    const listed = waitForEvent<{ messages: MessageEvent[] }>(bobClient, 'messages:list');
    bobClient.emit('messages:get', { roomId: room.id });
    const page = await listed;
    expect(page.messages.find((entry) => entry.id === message.id)?.reactions).toEqual(both.reactions);

    const removed = reactionFor(bobClient, message.id);
    aliceClient.emit('message:react', { messageId: message.id, emoji: null });
    await expect(removed).resolves.toMatchObject({ reactions: [{ userId: bob.user.id, emoji: heart }] });
  });

  it('rejects plaintext, oversized, malformed and stale-key reactions without storing them', async () => {
    const h = await start();
    const { room, aliceClient, bobClient } = await setupPair(h);
    const message = await sendFrom(bobClient, room.id, 'oi');
    const broadcasts = collectEvents<ReactionsEvent>(bobClient, 'message:reactions-updated');

    const plaintext = reactionErrorFor(aliceClient, message.id);
    aliceClient.emit('message:react', { messageId: message.id, emoji: '❤️' });
    await expect(plaintext).resolves.toMatchObject({ code: 'message.unsupportedEncryption' });

    const oversized = reactionErrorFor(aliceClient, message.id);
    aliceClient.emit('message:react', { messageId: message.id, emoji: fakeField('x'.repeat(400)) });
    await expect(oversized).resolves.toMatchObject({ code: 'validation.invalidPayload' });

    const stale = reactionErrorFor(aliceClient, message.id);
    aliceClient.emit('message:react', { messageId: message.id, emoji: fakeField('heart', newKeyId()) });
    await expect(stale).resolves.toMatchObject({ code: 'message.staleRoomKey' });

    const missing = waitForEvent<ErrorEvent>(aliceClient, 'error', (event) => event.event === 'message:react' && event.messageId === undefined);
    aliceClient.emit('message:react', { emoji: fakeField('heart') });
    await expect(missing).resolves.toMatchObject({ code: 'validation.invalidPayload' });

    await settle(50);
    expect(broadcasts).toHaveLength(0);
    const views = await h.messageService.toViews([(await h.messageService.getMessage(message.id))!]);
    expect(views[0]?.reactions).toEqual([]);
  });

  it('refuses system messages, messages deleted for everyone and messages of other rooms', async () => {
    const h = await start();
    const { room, aliceClient, bobClient } = await setupPair(h);
    const system = await h.messageService.createSystemMessage(room.id, systemEvent('group.created', { actor: 'Alice' }));
    const systemError = reactionErrorFor(aliceClient, system.id);
    aliceClient.emit('message:react', { messageId: system.id, emoji: fakeField('heart') });
    await expect(systemError).resolves.toMatchObject({ code: 'message.reactionUnavailable' });

    const doomed = await sendFrom(bobClient, room.id, 'apago');
    const deleted = waitForEvent(aliceClient, 'message:deleted');
    bobClient.emit('message:delete', { messageId: doomed.id });
    await deleted;
    const deletedError = reactionErrorFor(aliceClient, doomed.id);
    aliceClient.emit('message:react', { messageId: doomed.id, emoji: fakeField('heart') });
    await expect(deletedError).resolves.toMatchObject({ code: 'message.reactionUnavailable' });

    const carol = await h.createAccount('Carol');
    const dave = await h.createAccount('Dave');
    const otherRoom = await h.roomService.createPrivateRoom(carol.user.id, dave.user.id);
    const foreign = await h.messageService.sendMessage({ roomId: otherRoom.id, senderId: carol.user.id, content: fakeField('segredo') });
    const foreignError = reactionErrorFor(aliceClient, foreign.id);
    aliceClient.emit('message:react', { messageId: foreign.id, emoji: fakeField('heart') });
    await expect(foreignError).resolves.toMatchObject({ code: 'message.notFound' });

    const views = await h.messageService.toViews([foreign]);
    expect(views[0]?.reactions).toEqual([]);
  });

  it('clears the reactions of a message deleted for everyone', async () => {
    const h = await start();
    const { room, aliceClient, bobClient } = await setupPair(h);
    const message = await sendFrom(bobClient, room.id, 'apago depois');
    const reacted = reactionFor(bobClient, message.id);
    aliceClient.emit('message:react', { messageId: message.id, emoji: fakeField('heart') });
    await reacted;

    const deleted = waitForEvent(aliceClient, 'message:deleted');
    bobClient.emit('message:delete', { messageId: message.id });
    await deleted;

    const record = (await h.messageService.getMessage(message.id))!;
    const [view] = await h.messageService.toViews([record]);
    expect(view?.reactions).toEqual([]);
    const undeleted = { ...record, deletedForEveryone: false };
    const [raw] = await h.messageService.toViews([undeleted]);
    expect(raw?.reactions).toEqual([]);
  });

  it('does not deliver reaction updates to members who cannot see the message', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const carol = await h.createAccount('Carol');
    const mallory = await h.createAccount('Mallory');
    const group = await h.roomService.createGroupRoom(alice.user.id);
    await h.joinGroup(group.id, carol.user.id);
    await settle(5);
    const old = await h.messageService.sendMessage({ roomId: group.id, senderId: alice.user.id, content: fakeField('antigo') });
    await h.messageService.reactToMessage(old, carol.user.id, fakeField('heart'));
    await settle(20);
    await h.joinGroup(group.id, mallory.user.id);

    const aliceClient = await h.connectAs(alice);
    const carolClient = await h.connectAs(carol);
    const malloryClient = await h.connectAs(mallory);
    await Promise.all([joinVisibleRooms(aliceClient), joinVisibleRooms(carolClient), joinVisibleRooms(malloryClient)]);
    const malloryUpdates = collectEvents<ReactionsEvent>(malloryClient, 'message:reactions-updated');

    const aliceSaw = reactionFor(aliceClient, old.id);
    carolClient.emit('message:react', { messageId: old.id, emoji: null });
    await expect(aliceSaw).resolves.toMatchObject({ reactions: [] });

    const malloryError = reactionErrorFor(malloryClient, old.id);
    malloryClient.emit('message:react', { messageId: old.id, emoji: null });
    await expect(malloryError).resolves.toMatchObject({ code: 'message.notFound' });

    await settle(100);
    expect(malloryUpdates).toHaveLength(0);
  });
});
