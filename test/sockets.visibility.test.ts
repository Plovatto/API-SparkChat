import { afterEach, describe, expect, it } from 'vitest';
import { collectEvents, settle, startSocketHarness, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

interface MessageEvent {
  id: string;
  playedBy: string[];
  deliveredTo: string[];
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

async function groupWithLateJoiner(h: Harness, options: { carolOffline?: boolean } = {}) {
  const alice = await h.createAccount('Alice');
  const carol = await h.createAccount('Carol');
  const mallory = await h.createAccount('Mallory');
  const group = await h.roomService.createGroupRoom('Amigos', alice.user.id);
  await h.roomService.joinByCode(group.roomCode ?? '', carol.user.id);
  if (options.carolOffline) {
    await h.userService.setStatus(carol.user.id, 'offline');
  }
  const audio = await h.messageService.sendMessage({
    roomId: group.id,
    senderId: alice.user.id,
    content: 'https://cdn.test/uploads/audio/antigo.webm',
    type: 'audio',
    duration: 3,
    participantIds: [alice.user.id, carol.user.id],
  });
  await settle(20);
  await h.roomService.joinByCode(group.roomCode ?? '', mallory.user.id);
  return { alice, carol, mallory, group, audio };
}

describe('audio:played visibility', () => {
  it('does not send an older voice note to a member who joined after it was sent', async () => {
    const h = await start();
    const { alice, carol, mallory, audio } = await groupWithLateJoiner(h);
    const aliceClient = await h.connectAs(alice);
    const carolClient = await h.connectAs(carol);
    const malloryClient = await h.connectAs(mallory);
    await Promise.all([joinVisibleRooms(aliceClient), joinVisibleRooms(carolClient), joinVisibleRooms(malloryClient)]);
    const malloryUpdates = collectEvents<MessageEvent>(malloryClient, 'message:updated');

    const aliceSaw = waitForEvent<MessageEvent>(aliceClient, 'message:updated', (event) => event.id === audio.id);
    carolClient.emit('audio:played', { messageId: audio.id });

    await expect(aliceSaw).resolves.toMatchObject({ playedBy: [carol.user.id] });
    await settle(100);
    expect(malloryUpdates.filter((event) => event.id === audio.id)).toHaveLength(0);
  });

  it('ignores audio:played from a member whose visibility cutoff hides the message', async () => {
    const h = await start();
    const { alice, mallory, audio } = await groupWithLateJoiner(h);
    const aliceClient = await h.connectAs(alice);
    const malloryClient = await h.connectAs(mallory);
    await Promise.all([joinVisibleRooms(aliceClient), joinVisibleRooms(malloryClient)]);
    const updates = [...collectEvents<MessageEvent>(aliceClient, 'message:updated'), ...collectEvents<MessageEvent>(malloryClient, 'message:updated')];

    malloryClient.emit('audio:played', { messageId: audio.id });
    await settle(150);

    expect(updates).toHaveLength(0);
    expect((await h.messageService.getMessage(audio.id))?.playedBy).toEqual([]);
  });
});

describe('delivery receipts visibility', () => {
  it('does not mark or broadcast older messages as delivered to a member who joined after them', async () => {
    const h = await start();
    const { alice, carol, mallory, audio } = await groupWithLateJoiner(h, { carolOffline: true });
    const aliceClient = await h.connectAs(alice);
    const malloryClient = await h.connectAs(mallory);
    await Promise.all([joinVisibleRooms(aliceClient), joinVisibleRooms(malloryClient)]);
    const malloryUpdates = collectEvents<MessageEvent>(malloryClient, 'message:updated');

    const delivered = waitForEvent<MessageEvent>(aliceClient, 'message:updated', (event) => event.id === audio.id);
    await h.connectAs(carol);

    await expect(delivered).resolves.toMatchObject({ id: audio.id });
    await settle(100);
    expect(malloryUpdates).toHaveLength(0);
    expect((await h.messageService.getMessage(audio.id))?.deliveredTo).not.toContain(mallory.user.id);
  });
});

describe('mark-read visibility', () => {
  it('does not mark messages hidden by the cutoff as read when no ids are given', async () => {
    const h = await start();
    const { mallory, group, audio } = await groupWithLateJoiner(h);
    const malloryClient = await h.connectAs(mallory);
    await joinVisibleRooms(malloryClient);

    const done = waitForEvent<{ unreadCount: number }>(malloryClient, 'message:mark-read-done');
    malloryClient.emit('message:mark-read', { roomId: group.id });

    await expect(done).resolves.toMatchObject({ unreadCount: 0 });
    expect((await h.messageService.getMessage(audio.id))?.readBy).not.toContain(mallory.user.id);
  });

  it('does not mark hidden messages as read even when their ids are given', async () => {
    const h = await start();
    const { mallory, group, audio } = await groupWithLateJoiner(h);
    const malloryClient = await h.connectAs(mallory);
    await joinVisibleRooms(malloryClient);

    const done = waitForEvent(malloryClient, 'message:mark-read-done');
    malloryClient.emit('message:mark-read', { roomId: group.id, messageIds: [audio.id] });
    await done;

    expect((await h.messageService.getMessage(audio.id))?.readBy).not.toContain(mallory.user.id);
  });
});
