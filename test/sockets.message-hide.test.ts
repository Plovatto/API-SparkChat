import { afterEach, describe, expect, it } from 'vitest';
import { listSocketEvents } from '@/docs/socket-registry.js';
import { DEFAULT_SOCKET_EVENT_BUDGETS } from '@/sockets/socket-rate-limit.js';
import { collectEvents, settle, startSocketHarness, waitForEvent, type TestClient } from './support/socket-harness.js';

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await settle(20);
  }
}

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

interface ErrorEvent {
  code: string;
  event?: string;
  messageIds?: string[];
}

interface HiddenEvent {
  roomId: string;
  messageIds: string[];
  lastMessage: { id: string; content: string } | null;
  unreadCount: number;
  mentionCount: number;
}

interface MessagesList {
  roomId: string;
  messages: { id: string; replyTo: { id: string; content: string } | null }[];
  hasMore: boolean;
}

interface RoomsList {
  rooms: { id: string; lastMessage: { id: string } | null; unreadCount: number; mentionCount: number }[];
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

async function listRooms(client: TestClient): Promise<RoomsList> {
  const listed = waitForEvent<RoomsList>(client, 'rooms:list');
  client.emit('rooms:get');
  return listed;
}

async function getMessages(client: TestClient, payload: { roomId: string; before?: string | undefined; limit?: number }): Promise<MessagesList> {
  const listed = waitForEvent<MessagesList>(client, 'messages:list', (event) => event.roomId === payload.roomId);
  client.emit('messages:get', payload);
  return listed;
}

async function setupPair(h: Harness) {
  const alice = await h.createAccount('Alice');
  const bob = await h.createAccount('Bob');
  const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
  await h.roomService.createPrivateRoom(bob.user.id, alice.user.id);
  const aliceClient = await h.connectAs(alice);
  const bobClient = await h.connectAs(bob);
  await Promise.all([listRooms(aliceClient), listRooms(bobClient)]);
  return { alice, bob, room, aliceClient, bobClient };
}

describe('message:hide', () => {
  it('hides own and other people messages for every device of the requester only', async () => {
    const h = await start();
    const { alice, bob, room, aliceClient, bobClient } = await setupPair(h);
    const aliceLaptop = await h.connectAs(alice);
    const first = await h.messageService.sendMessage({ roomId: room.id, senderId: alice.user.id, content: 'primeira' });
    const own = await h.messageService.sendMessage({ roomId: room.id, senderId: alice.user.id, content: 'minha' });
    const other = await h.messageService.sendMessage({ roomId: room.id, senderId: bob.user.id, content: 'do bob' });
    const bobEvents = collectEvents(bobClient, 'message:hidden');

    const onPhone = waitForEvent<HiddenEvent>(aliceClient, 'message:hidden');
    const onLaptop = waitForEvent<HiddenEvent>(aliceLaptop, 'message:hidden');
    aliceClient.emit('message:hide', { messageIds: [own.id, other.id] });

    const expected = { roomId: room.id, messageIds: [own.id, other.id], lastMessage: { id: first.id }, unreadCount: 0, mentionCount: 0 };
    await expect(onPhone).resolves.toMatchObject(expected);
    await expect(onLaptop).resolves.toMatchObject(expected);

    const aliceView = await getMessages(aliceClient, { roomId: room.id });
    expect(aliceView.messages.map((message) => message.id)).toEqual([first.id]);
    const bobView = await getMessages(bobClient, { roomId: room.id });
    expect(bobView.messages.map((message) => message.id)).toEqual([first.id, own.id, other.id]);
    await settle(50);
    expect(bobEvents).toHaveLength(0);
  });

  it('keeps pagination and hasMore correct around many hidden messages', async () => {
    const h = await start();
    const { alice, bob, room, aliceClient } = await setupPair(h);
    const sent = [];
    for (let index = 0; index < 30; index += 1) {
      sent.push(await h.messageService.sendMessage({ roomId: room.id, senderId: index % 2 ? alice.user.id : bob.user.id, content: `m${index}` }));
    }
    const visible = sent.filter((_, index) => index < 3 || index % 10 === 0);
    const hidden = sent.filter((message) => !visible.includes(message));

    const done = waitForEvent(aliceClient, 'message:hidden');
    aliceClient.emit('message:hide', { messageIds: hidden.map((message) => message.id) });
    await done;

    const latest = await getMessages(aliceClient, { roomId: room.id, limit: 2 });
    expect(latest.messages.map((message) => message.id)).toEqual(visible.slice(-2).map((message) => message.id));
    expect(latest.hasMore).toBe(true);

    const older = await getMessages(aliceClient, { roomId: room.id, limit: 2, before: sent[10]?.timestamp });
    expect(older.messages.map((message) => message.id)).toEqual(visible.slice(1, 3).map((message) => message.id));
    expect(older.hasMore).toBe(true);

    const oldest = await getMessages(aliceClient, { roomId: room.id, limit: 2, before: sent[1]?.timestamp });
    expect(oldest.messages.map((message) => message.id)).toEqual([sent[0]?.id]);
    expect(oldest.hasMore).toBe(false);
  });

  it('excludes hidden messages from the room preview, unread and mention counts', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const group = await h.roomService.createGroupRoom(alice.user.id);
    await h.joinGroup(group.id, bob.user.id);
    const bobClient = await h.connectAs(bob);
    await listRooms(bobClient);
    const kept = await h.messageService.sendMessage({ roomId: group.id, senderId: alice.user.id, content: 'fica' });
    const mention = await h.messageService.sendMessage({ roomId: group.id, senderId: alice.user.id, content: '@Bob', mentionedUserIds: [bob.user.id] });
    const latest = await h.messageService.sendMessage({ roomId: group.id, senderId: alice.user.id, content: 'última' });

    const before = (await listRooms(bobClient)).rooms.find((candidate) => candidate.id === group.id);
    expect(before).toMatchObject({ lastMessage: { id: latest.id }, mentionCount: 1 });
    const unreadBefore = before?.unreadCount ?? 0;

    const hiddenEvent = waitForEvent<HiddenEvent>(bobClient, 'message:hidden');
    bobClient.emit('message:hide', { messageIds: [mention.id, latest.id] });
    await expect(hiddenEvent).resolves.toMatchObject({ lastMessage: { id: kept.id }, unreadCount: unreadBefore - 2, mentionCount: 0 });

    const after = (await listRooms(bobClient)).rooms.find((candidate) => candidate.id === group.id);
    expect(after).toMatchObject({ lastMessage: { id: kept.id }, unreadCount: unreadBefore - 2, mentionCount: 0 });

    const done = waitForEvent<{ unreadCount: number; mentionCount: number }>(bobClient, 'message:mark-read-done');
    bobClient.emit('message:mark-read', { roomId: group.id, messageIds: [kept.id] });
    await expect(done).resolves.toMatchObject({ unreadCount: unreadBefore - 3, mentionCount: 0 });
  });

  it('lets a message deleted for everyone be hidden and keeps replies quoting a hidden message', async () => {
    const h = await start();
    const { alice, bob, room, aliceClient } = await setupPair(h);
    const original = await h.messageService.sendMessage({ roomId: room.id, senderId: bob.user.id, content: 'original' });
    const reply = await h.messageService.sendMessage({ roomId: room.id, senderId: alice.user.id, content: 'resposta', replyToMessageId: original.id });
    const removed = await h.messageService.sendMessage({ roomId: room.id, senderId: bob.user.id, content: 'vai sumir' });
    await h.messageService.deleteMessage(removed.id, bob.user.id);

    const done = waitForEvent<HiddenEvent>(aliceClient, 'message:hidden');
    aliceClient.emit('message:hide', { messageIds: [original.id, removed.id] });
    await expect(done).resolves.toMatchObject({ lastMessage: { id: reply.id } });

    const view = await getMessages(aliceClient, { roomId: room.id });
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]).toMatchObject({ id: reply.id, replyTo: { id: original.id, content: 'original' } });
  });

  it('is idempotent when the same message is hidden twice', async () => {
    const h = await start();
    const { alice, room, aliceClient } = await setupPair(h);
    const message = await h.messageService.sendMessage({ roomId: room.id, senderId: alice.user.id, content: 'oi' });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const done = waitForEvent<HiddenEvent>(aliceClient, 'message:hidden');
      aliceClient.emit('message:hide', { messageIds: [message.id] });
      await expect(done).resolves.toMatchObject({ messageIds: [message.id], lastMessage: null });
    }
  });
});

describe('message:hide permissions', () => {
  it('rejects a message from a room the requester is not part of', async () => {
    const h = await start();
    const { aliceClient } = await setupPair(h);
    const carol = await h.createAccount('Carol');
    const dave = await h.createAccount('Dave');
    const foreignRoom = await h.roomService.createPrivateRoom(carol.user.id, dave.user.id);
    const foreign = await h.messageService.sendMessage({ roomId: foreignRoom.id, senderId: carol.user.id, content: 'privada' });
    const hidden = collectEvents(aliceClient, 'message:hidden');

    const error = waitForEvent<ErrorEvent>(aliceClient, 'error', (event) => event.event === 'message:hide');
    aliceClient.emit('message:hide', { messageIds: [foreign.id] });

    await expect(error).resolves.toMatchObject({ code: 'message.notFound' });
    const daveClient = await h.connectAs(dave);
    await listRooms(daveClient);
    const daveView = await getMessages(daveClient, { roomId: foreignRoom.id });
    expect(daveView.messages.map((message) => message.id)).toEqual([foreign.id]);
    expect(hidden).toHaveLength(0);
  });

  it('rejects a batch mixing messages from different rooms and hides nothing', async () => {
    const h = await start();
    const { alice, room, aliceClient } = await setupPair(h);
    const carol = await h.createAccount('Carol');
    const otherRoom = await h.roomService.createPrivateRoom(alice.user.id, carol.user.id);
    const here = await h.messageService.sendMessage({ roomId: room.id, senderId: alice.user.id, content: 'aqui' });
    const there = await h.messageService.sendMessage({ roomId: otherRoom.id, senderId: alice.user.id, content: 'lá' });

    const error = waitForEvent<ErrorEvent>(aliceClient, 'error', (event) => event.event === 'message:hide');
    aliceClient.emit('message:hide', { messageIds: [here.id, there.id] });

    await expect(error).resolves.toMatchObject({ code: 'message.hideMixedRooms', messageIds: [here.id, there.id] });
    const view = await getMessages(aliceClient, { roomId: room.id });
    expect(view.messages.map((message) => message.id)).toEqual([here.id]);
  });

  it('rejects a message hidden from the requester by the visibility cutoff', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const mallory = await h.createAccount('Mallory');
    const group = await h.roomService.createGroupRoom(alice.user.id);
    const old = await h.messageService.sendMessage({ roomId: group.id, senderId: alice.user.id, content: 'antes de entrar' });
    await settle(20);
    await h.joinGroup(group.id, mallory.user.id);
    const malloryClient = await h.connectAs(mallory);
    await listRooms(malloryClient);

    const error = waitForEvent<ErrorEvent>(malloryClient, 'error', (event) => event.event === 'message:hide');
    malloryClient.emit('message:hide', { messageIds: [old.id] });

    await expect(error).resolves.toMatchObject({ code: 'message.notFound' });
  });

  it('answers not found instead of revealing that an id lives in a room the requester is not part of', async () => {
    const h = await start();
    const { alice, room, aliceClient } = await setupPair(h);
    const carol = await h.createAccount('Carol');
    const dave = await h.createAccount('Dave');
    const foreignRoom = await h.roomService.createPrivateRoom(carol.user.id, dave.user.id);
    const here = await h.messageService.sendMessage({ roomId: room.id, senderId: alice.user.id, content: 'aqui' });
    const foreign = await h.messageService.sendMessage({ roomId: foreignRoom.id, senderId: carol.user.id, content: 'privada' });

    const error = waitForEvent<ErrorEvent>(aliceClient, 'error', (event) => event.event === 'message:hide');
    aliceClient.emit('message:hide', { messageIds: [here.id, foreign.id] });

    await expect(error).resolves.toMatchObject({ code: 'message.notFound', messageIds: [here.id, foreign.id] });
  });

  it('returns the requested ids with every error so the client can undo exactly that request', async () => {
    const h = await start({ socketEventBudgets: { events: { 'message:hide': { capacity: 1, refillPerSecond: 0.001 } }, fallback: { capacity: 100, refillPerSecond: 100 } } });
    const { alice, room, aliceClient } = await setupPair(h);
    const first = await h.messageService.sendMessage({ roomId: room.id, senderId: alice.user.id, content: 'um' });
    const second = await h.messageService.sendMessage({ roomId: room.id, senderId: alice.user.id, content: 'dois' });

    const done = waitForEvent(aliceClient, 'message:hidden');
    aliceClient.emit('message:hide', { messageIds: [first.id] });
    await done;

    const limited = waitForEvent<ErrorEvent>(aliceClient, 'error', (event) => event.event === 'message:hide');
    aliceClient.emit('message:hide', { messageIds: [second.id] });
    await expect(limited).resolves.toMatchObject({ code: 'rateLimit.socket', messageIds: [second.id] });
  });

  it('rejects unknown ids, empty, duplicated or oversized batches', async () => {
    const h = await start();
    const { alice, room, aliceClient } = await setupPair(h);
    const message = await h.messageService.sendMessage({ roomId: room.id, senderId: alice.user.id, content: 'oi' });

    const cases: [unknown, string][] = [
      [{ messageIds: [message.id, 'missing'] }, 'message.notFound'],
      [{ messageIds: [] }, 'validation.invalidPayload'],
      [{ messageIds: [message.id, message.id] }, 'validation.invalidPayload'],
      [{ messageIds: Array.from({ length: 101 }, (_, index) => `id-${index}`) }, 'validation.invalidPayload'],
      [{}, 'validation.invalidPayload'],
    ];

    for (const [payload, code] of cases) {
      const error = waitForEvent<ErrorEvent>(aliceClient, 'error', (event) => event.event === 'message:hide');
      aliceClient.emit('message:hide', payload);
      await expect(error).resolves.toMatchObject({ code });
    }

    const view = await getMessages(aliceClient, { roomId: room.id });
    expect(view.messages.map((candidate) => candidate.id)).toEqual([message.id]);
  });

  it('requires an authenticated socket', async () => {
    const h = await start();
    const anonymous = await h.connect();

    const error = waitForEvent<ErrorEvent>(anonymous, 'error');
    anonymous.emit('message:hide', { messageIds: ['x'] });

    await expect(error).resolves.toMatchObject({ code: 'auth.unauthenticated' });
  });
});

describe('message:delete batches', () => {
  it('deletes many own messages for everyone in one request, beyond the per-event burst', async () => {
    const h = await start();
    const { alice, room, aliceClient, bobClient } = await setupPair(h);
    const own = [];
    for (let index = 0; index < 35; index += 1) {
      own.push(await h.messageService.sendMessage({ roomId: room.id, senderId: alice.user.id, content: `m${index}` }));
    }
    const deleted = collectEvents<{ messageId: string }>(bobClient, 'message:deleted');
    const errors = collectEvents<ErrorEvent>(aliceClient, 'error');

    aliceClient.emit('message:delete', { messageIds: own.map((message) => message.id) });

    await waitFor(() => deleted.length === own.length);
    expect(new Set(deleted.map((event) => event.messageId))).toEqual(new Set(own.map((message) => message.id)));
    expect(errors).toHaveLength(0);
    const stored = await Promise.all(own.map((message) => h.messageService.getMessage(message.id)));
    expect(stored.every((message) => message?.deletedForEveryone)).toBe(true);
  });

  it('deletes the allowed messages and reports exactly the ones it could not delete', async () => {
    const h = await start();
    const { alice, bob, room, aliceClient } = await setupPair(h);
    const own = await h.messageService.sendMessage({ roomId: room.id, senderId: alice.user.id, content: 'minha' });
    const other = await h.messageService.sendMessage({ roomId: room.id, senderId: bob.user.id, content: 'do bob' });

    const error = waitForEvent<ErrorEvent>(aliceClient, 'error', (event) => event.event === 'message:delete');
    aliceClient.emit('message:delete', { messageIds: [own.id, other.id] });

    await expect(error).resolves.toMatchObject({ code: 'message.deleteForbidden', messageIds: [other.id] });
    expect((await h.messageService.getMessage(own.id))?.deletedForEveryone).toBe(true);
    expect((await h.messageService.getMessage(other.id))?.deletedForEveryone).toBe(false);
  });

  it('keeps the single id payload of older clients and rejects malformed batches', async () => {
    const h = await start();
    const { alice, room, aliceClient, bobClient } = await setupPair(h);
    const own = await h.messageService.sendMessage({ roomId: room.id, senderId: alice.user.id, content: 'antiga' });

    const deleted = waitForEvent<{ messageId: string }>(bobClient, 'message:deleted');
    aliceClient.emit('message:delete', { messageId: own.id });
    await expect(deleted).resolves.toMatchObject({ messageId: own.id });

    const tooMany = Array.from({ length: 101 }, (_, index) => `id-${index}`);
    const invalid = waitForEvent<ErrorEvent>(aliceClient, 'error', (event) => event.event === 'message:delete');
    aliceClient.emit('message:delete', { messageIds: [own.id, own.id] });
    await expect(invalid).resolves.toMatchObject({ code: 'validation.invalidPayload', messageIds: [own.id, own.id] });

    const oversized = waitForEvent<ErrorEvent>(aliceClient, 'error', (event) => event.code === 'validation.invalidPayload' && event.event === undefined);
    aliceClient.emit('message:delete', { messageIds: tooMany });
    await expect(oversized).resolves.toMatchObject({ code: 'validation.invalidPayload' });
  });
});

describe('message:hide contract', () => {
  it('is documented in the socket registry and has its own rate limit budget', () => {
    const events = listSocketEvents();
    const clientEvent = events.find((event) => event.event === 'message:hide' && event.direction === 'client-to-server');
    const serverEvent = events.find((event) => event.event === 'message:hidden' && event.direction === 'server-to-client');

    expect(clientEvent?.payloadSchema).toMatchObject({
      properties: { messageIds: { type: 'array', minItems: 1, maxItems: 100 } },
      required: ['messageIds'],
    });
    expect((serverEvent?.payloadSchema as { required?: string[] } | undefined)?.required?.slice().sort()).toEqual(
      ['lastMessage', 'mentionCount', 'messageIds', 'roomId', 'unreadCount'],
    );
    expect(DEFAULT_SOCKET_EVENT_BUDGETS.events['message:hide']).toEqual({ capacity: 30, refillPerSecond: 5 });
  });
});
