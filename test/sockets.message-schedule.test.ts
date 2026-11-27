import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { users } from '@/database/schema.js';
import { fakeField, newKeyId } from './support/room-keys.js';
import { startSocketHarness, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

interface ErrorEvent {
  code: string;
  clientTempId?: string;
}

const ASSISTANT_ID = 'assistant-not-in-tests';
const SEND_AT = Date.now() + 3_600_000;

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

async function setup(schedule = vi.fn().mockResolvedValue({ ok: true, id: 'row-1' })) {
  const cancel = vi.fn().mockResolvedValue(true);
  const h = await startSocketHarness({ scheduledMessages: { schedule, cancel } });
  harness = h;
  const alice = await h.createAccount('Alice');
  const bob = await h.createAccount('Bob');
  const carol = await h.createAccount('Carol');
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
  const bobRoom = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
  const carolRoom = await h.roomService.createPrivateRoom(carol.user.id, bob.user.id);
  const aiKeyId = await h.establishRoomKey(aiRoom.id);
  const bobKeyId = await h.establishRoomKey(bobRoom.id);
  await h.establishRoomKey(carolRoom.id);
  const client = await h.connectAs(alice);
  await joinVisibleRooms(client);
  return { h, alice, bob, aiRoom, bobRoom, carolRoom, aiKeyId, bobKeyId, client, schedule, cancel };
}

function payload(roomId: string, keyId: string, overrides: Record<string, unknown> = {}) {
  return {
    cardId: randomUUID(),
    roomId,
    sendAt: SEND_AT,
    messageId: randomUUID(),
    content: fakeField('bom dia', keyId),
    type: 'text',
    clientTempId: 'tmp-1',
    ...overrides,
  };
}

async function expectError(client: TestClient, data: Record<string, unknown>, code: string) {
  const error = waitForEvent<ErrorEvent>(client, 'error');
  client.emit('message:schedule', data);
  await expect(error).resolves.toMatchObject({ code, clientTempId: 'tmp-1' });
}

describe('message:schedule', () => {
  it('hands a valid payload to the scheduling service with the key id of the content', async () => {
    const { bobRoom, bobKeyId, client, alice, schedule } = await setup();
    const data = payload(bobRoom.id, bobKeyId);
    client.emit('message:schedule', data);

    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
    expect(schedule.mock.calls[0]?.[0]).toMatchObject({
      userId: alice.user.id,
      cardId: data.cardId,
      roomId: bobRoom.id,
      sendAt: SEND_AT,
      messageId: data.messageId,
      content: data.content,
      keyId: bobKeyId,
    });
  });

  it('rejects an old room key with message.staleRoomKey and the sent clientTempId', async () => {
    const { bobRoom, client, schedule } = await setup();
    await expectError(client, payload(bobRoom.id, newKeyId()), 'message.staleRoomKey');
    expect(schedule).not.toHaveBeenCalled();
  });

  it('rejects content that is not encrypted', async () => {
    const { bobRoom, client } = await setup();
    await expectError(client, payload(bobRoom.id, 'x', { content: 'texto aberto' }), 'message.unsupportedEncryption');
  });

  it('rejects a room the person is not in', async () => {
    const { carolRoom, bobKeyId, client } = await setup();
    await expectError(client, payload(carolRoom.id, bobKeyId), 'room.notFound');
  });

  it('rejects a blocked room', async () => {
    const { h, alice, bob, bobRoom, bobKeyId, client } = await setup();
    await h.roomService.blockUser(bobRoom.id, bob.user.id, alice.user.id);
    await expectError(client, payload(bobRoom.id, bobKeyId), 'message.blocked');
  });

  it('never schedules into the SparkAI room', async () => {
    const { aiRoom, aiKeyId, client, schedule } = await setup();
    await expectError(client, payload(aiRoom.id, aiKeyId), 'message.scheduleNotAllowed');
    expect(schedule).not.toHaveBeenCalled();
  });

  it('returns scheduleNotAllowed when the card is not pending and scheduleLimit at the cap', async () => {
    const rejecting = vi.fn().mockResolvedValueOnce({ ok: false, error: 'not_allowed' }).mockResolvedValueOnce({ ok: false, error: 'limit' });
    const { bobRoom, bobKeyId, client } = await setup(rejecting);
    await expectError(client, payload(bobRoom.id, bobKeyId), 'message.scheduleNotAllowed');
    await expectError(client, payload(bobRoom.id, bobKeyId), 'message.scheduleLimit');
  });

  it('rejects an invalid payload with the clientTempId', async () => {
    const { bobRoom, bobKeyId, client } = await setup();
    await expectError(client, payload(bobRoom.id, bobKeyId, { sendAt: 'amanha' }), 'validation.invalidPayload');
    await expectError(client, payload(bobRoom.id, bobKeyId, { cardId: 'nao-uuid' }), 'validation.invalidPayload');
    await expectError(client, payload(bobRoom.id, bobKeyId, { type: 'image' }), 'validation.invalidPayload');
  });
});

describe('message:unschedule', () => {
  it('cancels the own pending row and reports a missing one', async () => {
    const { client, cancel, alice } = await setup();
    const id = randomUUID();
    client.emit('message:unschedule', { id, clientTempId: 'tmp-1' });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(alice.user.id, id));

    cancel.mockResolvedValueOnce(false);
    const error = waitForEvent<ErrorEvent>(client, 'error');
    client.emit('message:unschedule', { id: randomUUID(), clientTempId: 'tmp-1' });
    await expect(error).resolves.toMatchObject({ code: 'message.scheduleNotFound', clientTempId: 'tmp-1' });
  });
});
