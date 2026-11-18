import { afterEach, describe, expect, it } from 'vitest';
import { collectEvents, settle, startSocketHarness, TEST_PASSWORD, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

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

describe('multi-device delivery', () => {
  it('keeps a user online until the last of their devices disconnects', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    const observer = await h.connectAs(bob);
    const phone = await h.connectAs(alice);
    const laptop = await h.connectAs(alice);
    const offline = collectEvents<{ userId: string }>(observer, 'user:offline');

    phone.disconnect();
    await settle(200);

    expect(offline.filter((event) => event.userId === alice.user.id)).toHaveLength(0);
    expect(h.userService.isOnline(alice.user.id)).toBe(true);

    const wentOffline = waitForEvent<{ userId: string }>(observer, 'user:offline', (event) => event.userId === alice.user.id);
    laptop.disconnect();
    await wentOffline;

    expect(h.userService.isOnline(alice.user.id)).toBe(false);
  });

  it('only marks a user offline when every device is hidden', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    const observer = await h.connectAs(bob);
    const phone = await h.connectAs(alice);
    const laptop = await h.connectAs(alice);
    const offline = collectEvents<{ userId: string }>(observer, 'user:offline');

    phone.emit('user:visibility', { visible: false });
    await settle(200);
    expect(offline.filter((event) => event.userId === alice.user.id)).toHaveLength(0);

    const wentOffline = waitForEvent<{ userId: string }>(observer, 'user:offline', (event) => event.userId === alice.user.id);
    laptop.emit('user:visibility', { visible: false });
    await wentOffline;

    const wentOnline = waitForEvent<{ userId: string }>(observer, 'user:online', (event) => event.userId === alice.user.id);
    phone.emit('user:visibility', { visible: true });
    await wentOnline;
  });

  it('delivers block and unblock notices to every device of both users', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    const aliceA = await h.connectAs(alice);
    const aliceB = await h.connectAs(alice);
    const bobA = await h.connectAs(bob);
    const bobB = await h.connectAs(bob);

    const blockedNotices = Promise.all([
      waitForEvent(aliceA, 'user:blocked', (event: { isBlocking: boolean }) => event.isBlocking),
      waitForEvent(aliceB, 'user:blocked', (event: { isBlocking: boolean }) => event.isBlocking),
      waitForEvent(bobA, 'user:blocked', (event: { isBlocking: boolean }) => !event.isBlocking),
      waitForEvent(bobB, 'user:blocked', (event: { isBlocking: boolean }) => !event.isBlocking),
    ]);
    aliceA.emit('user:block', { roomId: room.id, blockedUserId: bob.user.id });
    await blockedNotices;

    const unblockedNotices = Promise.all([
      waitForEvent(aliceB, 'user:unblocked'),
      waitForEvent(bobA, 'user:unblocked'),
      waitForEvent(bobB, 'user:unblocked'),
    ]);
    aliceA.emit('user:unblock', { roomId: room.id, blockedUserId: bob.user.id });
    await unblockedNotices;
  });

  it('removes every device of a removed member from the group', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const group = await h.roomService.createGroupRoom('Turma', alice.user.id);
    await h.roomService.joinByCode(group.roomCode ?? '', bob.user.id);
    const admin = await h.connectAs(alice);
    const bobA = await h.connectAs(bob);
    const bobB = await h.connectAs(bob);
    await Promise.all([joinVisibleRooms(admin), joinVisibleRooms(bobA), joinVisibleRooms(bobB)]);

    const leftNotices = Promise.all([
      waitForEvent(bobA, 'group:left', (event: { roomId: string }) => event.roomId === group.id),
      waitForEvent(bobB, 'group:left', (event: { roomId: string }) => event.roomId === group.id),
    ]);
    admin.emit('group:remove-member', { roomId: group.id, userId: bob.user.id });
    await leftNotices;

    const bobMessages = [...collectEvents(bobA, 'message:new'), ...collectEvents(bobB, 'message:new')];
    const delivered = waitForEvent(admin, 'message:new', (event: { content: string }) => event.content === 'depois da remoção');
    admin.emit('message:send', { roomId: group.id, content: 'depois da remoção' });
    await delivered;
    await settle(100);

    expect(bobMessages).toHaveLength(0);
  });

  it('pushes sealed room keys to every device of the recipient and to the other devices of the publisher', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    const aliceA = await h.connectAs(alice);
    const aliceB = await h.connectAs(alice);
    const bobA = await h.connectAs(bob);
    const bobB = await h.connectAs(bob);
    const echoedToPublisher = collectEvents(aliceA, 'e2e:room-key');

    const delivered = Promise.all([
      waitForEvent(bobA, 'e2e:room-key', (event: { sealedKey: string }) => event.sealedKey === 'sealed-bob'),
      waitForEvent(bobB, 'e2e:room-key', (event: { sealedKey: string }) => event.sealedKey === 'sealed-bob'),
      waitForEvent(aliceB, 'e2e:room-key', (event: { sealedKey: string }) => event.sealedKey === 'sealed-alice'),
    ]);
    aliceA.emit('e2e:publish-room-key', {
      roomId: room.id,
      keys: [
        { userId: alice.user.id, sealedKey: 'sealed-alice' },
        { userId: bob.user.id, sealedKey: 'sealed-bob' },
      ],
    });
    await delivered;
    await settle(50);

    expect(echoedToPublisher).toHaveLength(0);
  });

  it('syncs chat settings to the other devices of the same user only', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const aliceA = await h.connectAs(alice);
    const aliceB = await h.connectAs(alice);
    const echoed = collectEvents(aliceA, 'user:chat-settings-updated');

    const synced = waitForEvent<{ chatSettings: { globalWallpaper: string | null } }>(aliceB, 'user:chat-settings-updated');
    aliceA.emit('user:update-chat-settings', { globalWallpaper: 'aurora' });
    const result = await synced;
    await settle(50);

    expect(result.chatSettings.globalWallpaper).toBe('aurora');
    expect(echoed).toHaveLength(0);
  });

  it('announces a reactivated private chat to every device of the recipient and subscribes them to it', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    const aliceA = await h.connectAs(alice);
    const bobA = await h.connectAs(bob);
    const bobB = await h.connectAs(bob);
    await joinVisibleRooms(aliceA);

    const announced = Promise.all([
      waitForEvent(bobA, 'room:new', (event: { room: { id: string } }) => event.room.id === room.id),
      waitForEvent(bobB, 'room:new', (event: { room: { id: string } }) => event.room.id === room.id),
    ]);
    aliceA.emit('message:send', { roomId: room.id, content: 'primeira' });
    await announced;

    const followUps = Promise.all([
      waitForEvent(bobA, 'message:new', (event: { content: string }) => event.content === 'segunda'),
      waitForEvent(bobB, 'message:new', (event: { content: string }) => event.content === 'segunda'),
    ]);
    aliceA.emit('message:send', { roomId: room.id, content: 'segunda' });
    await followUps;
  });

  it('removes every device from a chat deleted for the user', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const group = await h.roomService.createGroupRoom('Turma', alice.user.id);
    await h.roomService.joinByCode(group.roomCode ?? '', bob.user.id);
    const bobA = await h.connectAs(bob);
    const bobB = await h.connectAs(bob);
    await Promise.all([joinVisibleRooms(bobA), joinVisibleRooms(bobB)]);

    const deleted = Promise.all([
      waitForEvent(bobA, 'room:deleted', (event: { roomId: string }) => event.roomId === group.id),
      waitForEvent(bobB, 'room:deleted', (event: { roomId: string }) => event.roomId === group.id),
    ]);
    bobA.emit('room:delete', { roomId: group.id });
    await deleted;
  });
});

interface ActivityUpdate {
  roomId: string;
  users: string[];
}

describe('per-socket room activity', () => {
  async function setupActivity(h: Harness) {
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    await h.roomService.createPrivateRoom(bob.user.id, alice.user.id);
    const bobClient = await h.connectAs(bob);
    const tabA = await h.connectAs(alice);
    const tabB = await h.connectAs(alice);
    await Promise.all([joinVisibleRooms(bobClient), joinVisibleRooms(tabA), joinVisibleRooms(tabB)]);
    return { alice, bob, room, bobClient, tabA, tabB };
  }

  async function startActivity(h: Harness, tab: TestClient, observer: TestClient, roomId: string, userId: string): Promise<void> {
    const typing = waitForEvent<ActivityUpdate>(observer, 'typing:update', (event) => event.users.includes(userId));
    const recording = waitForEvent<ActivityUpdate>(observer, 'recording:update', (event) => event.users.includes(userId));
    tab.emit('room:view-start', { roomId });
    tab.emit('typing:start', { roomId });
    tab.emit('recording:start', { roomId });
    await Promise.all([typing, recording]);
    await settle(100);
    expect(h.presenceService.getViewers(roomId)).toContain(userId);
  }

  it('clears the viewing, typing and recording state of a closed tab while another tab stays open', async () => {
    const h = await start();
    const { alice, room, bobClient, tabA, tabB } = await setupActivity(h);
    await startActivity(h, tabA, bobClient, room.id, alice.user.id);

    const typingCleared = waitForEvent<ActivityUpdate>(bobClient, 'typing:update', (event) => !event.users.includes(alice.user.id));
    const recordingCleared = waitForEvent<ActivityUpdate>(bobClient, 'recording:update', (event) => !event.users.includes(alice.user.id));
    tabA.disconnect();
    await Promise.all([typingCleared, recordingCleared]);

    expect(tabB.connected).toBe(true);
    expect(h.presenceService.getViewers(room.id)).not.toContain(alice.user.id);
    expect(h.typingService.stopTyping(room.id, 'probe')).toEqual([]);
  });

  it('keeps the user active in a room that another open tab still marks', async () => {
    const h = await start();
    const { alice, room, bobClient, tabA, tabB } = await setupActivity(h);
    await startActivity(h, tabA, bobClient, room.id, alice.user.id);
    tabB.emit('room:view-start', { roomId: room.id });
    tabB.emit('typing:start', { roomId: room.id });
    await settle(100);
    const typingUpdates = collectEvents<ActivityUpdate>(bobClient, 'typing:update');
    const recordingCleared = waitForEvent<ActivityUpdate>(bobClient, 'recording:update', (event) => !event.users.includes(alice.user.id));

    tabA.disconnect();
    await recordingCleared;
    await settle(100);

    expect(typingUpdates.filter((event) => !event.users.includes(alice.user.id))).toHaveLength(0);
    expect(h.presenceService.getViewers(room.id)).toContain(alice.user.id);

    const typingCleared = waitForEvent<ActivityUpdate>(bobClient, 'typing:update', (event) => !event.users.includes(alice.user.id));
    tabB.disconnect();
    await typingCleared;
    await settle(50);

    expect(h.presenceService.getViewers(room.id)).not.toContain(alice.user.id);
  });

  it('clears the activity of a tab that logs out while another device stays signed in', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const otherSession = await h.userService.login('Alice', TEST_PASSWORD);
    if (!otherSession) {
      throw new Error('login failed');
    }
    const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
    await h.roomService.createPrivateRoom(bob.user.id, alice.user.id);
    const bobClient = await h.connectAs(bob);
    const loggingOut = await h.connectAs(alice);
    const otherDevice = await h.connectAs(otherSession);
    await Promise.all([joinVisibleRooms(bobClient), joinVisibleRooms(loggingOut), joinVisibleRooms(otherDevice)]);
    await startActivity(h, loggingOut, bobClient, room.id, alice.user.id);

    const typingCleared = waitForEvent<ActivityUpdate>(bobClient, 'typing:update', (event) => !event.users.includes(alice.user.id));
    const recordingCleared = waitForEvent<ActivityUpdate>(bobClient, 'recording:update', (event) => !event.users.includes(alice.user.id));
    loggingOut.emit('user:logout');
    await Promise.all([typingCleared, recordingCleared]);

    expect(otherDevice.connected).toBe(true);
    expect(h.presenceService.getViewers(room.id)).not.toContain(alice.user.id);
  });
});
