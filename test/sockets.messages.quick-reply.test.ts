import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { users } from '@/database/schema.js';
import { fakeField } from './support/room-keys.js';
import { startSocketHarness, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

interface ErrorEvent {
  code: string;
  clientTempId?: string;
}

interface MessageEvent {
  id: string;
  quickReply?: { cardId: string; choice: string };
  assistantCard?: string;
}

const ASSISTANT_ID = 'assistant-not-in-tests';
const CARD_JSON = '{"v":1,"kind":"capabilities"}';

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function joinVisibleRooms(client: TestClient): Promise<void> {
  const listed = waitForEvent(client, 'rooms:list');
  client.emit('rooms:get');
  await listed;
}

async function setup() {
  const h = await startSocketHarness();
  harness = h;
  const alice = await h.createAccount('Alice');
  const bob = await h.createAccount('Bob');
  const now = new Date().toISOString();
  await h.db.insert(users).values({
    id: ASSISTANT_ID,
    nickname: 'Spark',
    nicknameNormalized: 'spark-ai-test',
    avatar: 0,
    passwordHash: 'x',
    recoveryTokenHash: 'x',
    createdAt: now,
    lastSeen: now,
  });
  const aiRoom = await h.roomService.createPrivateRoom(alice.user.id, ASSISTANT_ID);
  const plainRoom = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
  await h.roomService.createPrivateRoom(bob.user.id, alice.user.id);
  const aiKeyId = await h.establishRoomKey(aiRoom.id);
  const plainKeyId = await h.establishRoomKey(plainRoom.id);
  const client = await h.connectAs(alice);
  await joinVisibleRooms(client);
  return { h, aiRoom, plainRoom, aiKeyId, plainKeyId, client };
}

describe('message:send quickReply', () => {
  it('accepts and persists a quick reply in the assistant room and echoes it in message:new', async () => {
    const { h, aiRoom, aiKeyId, client } = await setup();
    const quickReply = { cardId: randomUUID(), choice: 'yes' };
    const messageId = randomUUID();

    const created = waitForEvent<MessageEvent>(client, 'message:new');
    client.emit('message:send', { roomId: aiRoom.id, content: fakeField('Sim', aiKeyId), messageId, quickReply });

    await expect(created).resolves.toMatchObject({ id: messageId, quickReply });
    expect((await h.messageService.getMessage(messageId))?.quickReply).toEqual(quickReply);
  });

  it('rejects a quick reply in a regular room', async () => {
    const { h, plainRoom, plainKeyId, client } = await setup();
    const messageId = randomUUID();

    const error = waitForEvent<ErrorEvent>(client, 'error');
    client.emit('message:send', {
      roomId: plainRoom.id,
      content: fakeField('Sim', plainKeyId),
      messageId,
      clientTempId: 'tmp-1',
      quickReply: { cardId: randomUUID(), choice: 'yes' },
    });

    await expect(error).resolves.toMatchObject({ code: 'message.quickReplyNotAllowed', clientTempId: 'tmp-1' });
    expect(await h.messageService.getMessage(messageId)).toBeNull();
  });

  it('rejects an unknown choice', async () => {
    const { h, aiRoom, aiKeyId, client } = await setup();
    const messageId = randomUUID();

    const error = waitForEvent<ErrorEvent>(client, 'error');
    client.emit('message:send', {
      roomId: aiRoom.id,
      content: fakeField('Sim', aiKeyId),
      messageId,
      quickReply: { cardId: randomUUID(), choice: 'explode' },
    });

    expect((await error).code).toBe('validation.invalidPayload');
    expect(await h.messageService.getMessage(messageId)).toBeNull();
  });

  it('never stores an assistantCard sent by the client', async () => {
    const { h, aiRoom, aiKeyId, client } = await setup();
    const messageId = randomUUID();

    const created = waitForEvent<MessageEvent>(client, 'message:new');
    client.emit('message:send', {
      roomId: aiRoom.id,
      content: fakeField('oi', aiKeyId),
      messageId,
      assistantCard: fakeField(CARD_JSON, aiKeyId),
    });

    const view = await created;
    expect(view.assistantCard).toBeUndefined();
    expect((await h.messageService.getMessage(messageId))?.assistantCard).toBeUndefined();
  });

  it('stores a server-produced assistant card and returns it in the view', async () => {
    const { h, aiRoom, aiKeyId } = await setup();
    const card = fakeField(CARD_JSON, aiKeyId);

    const record = await h.messageService.sendMessage({ roomId: aiRoom.id, senderId: ASSISTANT_ID, content: fakeField('oi', aiKeyId), assistantCard: card });
    const view = await h.messageService.toNewView(record);

    expect(view.assistantCard).toBe(card);
    expect((await h.messageService.getMessage(record.id))?.assistantCard).toBe(card);
  });
});
