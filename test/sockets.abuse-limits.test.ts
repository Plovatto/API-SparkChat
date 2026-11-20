import { roomParticipants } from '@/database/schema.js';
import { MAX_ROOM_KEY_BATCH } from '@/modules/rooms/room.socket.js';
import { userChatSettingsSchema, userThemeSchema } from '@/modules/users/user.model.js';
import { SOCKET_MAX_HTTP_BUFFER_SIZE } from '@/sockets/socket-options.js';
import { createEventLimiter, DEFAULT_SOCKET_EVENT_BUDGETS } from '@/sockets/socket-rate-limit.js';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeEnvelope, newKeyId } from './support/room-keys.js';
import { collectEvents, settle, startSocketHarness, waitForDisconnect, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

interface ErrorEvent {
  code: string;
  event?: string;
  clientTempId?: string;
}

interface RoomPayload {
  room: { id: string };
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

async function createGroup(client: TestClient, roomName: string): Promise<{ id: string }> {
  const created = waitForEvent<RoomPayload>(client, 'room:created');
  client.emit('room:create-group', { roomName });
  const { room } = await created;
  return { id: room.id };
}

const ID = '3e3f4a1e-3b7a-4f7b-8f2a-2b7a7b9b2b2a';

function largestValidMessageSend(): number {
  const fill = (length: number) => 'A'.repeat(length);
  const payload = {
    roomId: ID,
    content: fill(30000),
    type: 'text',
    duration: 999999,
    replyToMessageId: ID,
    messageId: ID,
    clientTempId: `temp-${ID}`,
    mentionedUserIds: Array.from({ length: 50 }, () => ID),
    caption: fill(3340),
    fileMeta: { name: fill(740), mimeType: fill(440), size: 123456789, thumbnailUrl: fill(4000) },
    linkPreview: { url: fill(4160), title: fill(4160), description: fill(8160), imageUrl: fill(4160), siteName: fill(1160) },
  };
  return Buffer.byteLength(`42${JSON.stringify(['message:send', payload])}`);
}

describe('socket payload size limit', () => {
  it('leaves at least 25% headroom over the largest valid message:send', () => {
    expect(largestValidMessageSend() * 1.25).toBeLessThan(SOCKET_MAX_HTTP_BUFFER_SIZE);
    expect(SOCKET_MAX_HTTP_BUFFER_SIZE).toBeLessThanOrEqual(128 * 1024);
  });

  it('fits a full room key batch for the largest group a rotation supports', () => {
    const keyId = newKeyId();
    const keys = Array.from({ length: MAX_ROOM_KEY_BATCH }, () => ({
      userId: ID,
      sealedKey: fakeEnvelope({ roomId: ID, keyId, epoch: 999999, senderId: ID, recipientId: ID }),
    }));
    const frame = `42${JSON.stringify(['e2e:publish-room-key', { roomId: ID, keyId, epoch: 999999, keys }])}`;

    expect(Buffer.byteLength(frame)).toBeLessThan(SOCKET_MAX_HTTP_BUFFER_SIZE);
  });

  it('disconnects a client that sends a frame above the limit', async () => {
    const h = await start();
    const client = await h.connect();
    const dropped = waitForDisconnect(client);

    client.emit('rooms:get', { padding: 'x'.repeat(SOCKET_MAX_HTTP_BUFFER_SIZE + 1) });

    await expect(dropped).resolves.toBeTruthy();
  });
});

describe('per-socket event budgets', () => {
  it('refills tokens over time and keeps unknown events in one shared bucket', () => {
    let now = 0;
    const tryConsume = createEventLimiter(
      { events: { 'typing:start': { capacity: 2, refillPerSecond: 1 } }, fallback: { capacity: 1, refillPerSecond: 1 } },
      () => now,
    );

    expect(tryConsume('typing:start')).toBe(true);
    expect(tryConsume('typing:start')).toBe(true);
    expect(tryConsume('typing:start')).toBe(false);
    now = 1000;
    expect(tryConsume('typing:start')).toBe(true);

    expect(tryConsume('made-up-1')).toBe(true);
    expect(tryConsume('made-up-2')).toBe(false);
  });

  it('gives normal chat activity room to breathe', () => {
    const { events } = DEFAULT_SOCKET_EVENT_BUDGETS;
    for (const event of ['typing:start', 'typing:stop', 'room:view-start', 'room:view-stop', 'message:mark-read']) {
      expect(events[event]?.capacity).toBeGreaterThanOrEqual(30);
      expect(events[event]?.refillPerSecond).toBeGreaterThanOrEqual(5);
    }
    expect(events['e2e:request-room-key']?.capacity).toBeGreaterThanOrEqual(200);
  });

  it('drops events over budget and tells the client once', async () => {
    const h = await start({
      socketEventBudgets: { events: { 'e2e:get-my-keys': { capacity: 2, refillPerSecond: 0.001 } }, fallback: { capacity: 100, refillPerSecond: 100 } },
    });
    const alice = await h.createAccount('Alice');
    const client = await h.connectAs(alice);
    const replies = collectEvents(client, 'e2e:my-keys');
    const errors = collectEvents<ErrorEvent>(client, 'error');

    for (let i = 0; i < 6; i += 1) {
      client.emit('e2e:get-my-keys');
    }
    await settle(200);

    expect(replies).toHaveLength(2);
    expect(errors).toEqual([expect.objectContaining({ code: 'rateLimit.socket', event: 'e2e:get-my-keys' })]);
  });
});

describe('room input limits', () => {
  it('rejects oversized nicknames in room:create-private', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const client = await h.connectAs(alice);

    const error = waitForEvent<ErrorEvent>(client, 'error');
    client.emit('room:create-private', { targetNickname: 'x'.repeat(500) });

    await expect(error).resolves.toMatchObject({ code: 'validation.invalidPayload' });
  });

  it('limits how many groups one user can create', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const client = await h.connectAs(alice);
    for (let i = 0; i < 10; i += 1) {
      await createGroup(client, `Grupo ${i}`);
    }

    const error = waitForEvent<ErrorEvent>(client, 'error');
    client.emit('room:create-group', { roomName: 'Mais um' });

    await expect(error).resolves.toMatchObject({ code: 'rateLimit.roomCreate' });
  });

  it.each(['ABCDEFG', 'ABCDEFGHIJKLM'])('rejects the invite code %s as an invalid format', async (roomCode) => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const client = await h.connectAs(alice);

    const error = waitForEvent<ErrorEvent>(client, 'error');
    client.emit('room:join-by-code', { roomCode });

    await expect(error).resolves.toMatchObject({ code: 'room.invalidCode' });
  });
});

describe('membership-gated socket paths and bans', () => {
  it('does not let a banned user with a leftover participant row subscribe to the room', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const group = await h.roomService.createGroupRoom(alice.user.id);
    await h.joinGroup(group.id, bob.user.id);
    await h.roomService.removeMember(group.id, alice.user.id, bob.user.id);
    await h.db.insert(roomParticipants).values({ roomId: group.id, userId: bob.user.id, isVisible: true });
    const bobClient = await h.connectAs(bob);

    const listed = waitForEvent<{ rooms: { id: string }[] }>(bobClient, 'rooms:list');
    bobClient.emit('rooms:get');
    expect((await listed).rooms).toEqual([]);

    const error = waitForEvent<ErrorEvent>(bobClient, 'error');
    bobClient.emit('room:join', { roomId: group.id });
    await expect(error).resolves.toMatchObject({ code: 'room.notFound' });
  });
});

describe('chat settings limits', () => {
  it('rejects oversized theme names and settings records', () => {
    expect(userThemeSchema.safeParse({ baseTheme: 'dark', colorTheme: 'x'.repeat(51) }).success).toBe(false);
    expect(userChatSettingsSchema.safeParse({ globalWallpaper: 'x'.repeat(101) }).success).toBe(false);

    const tooManyWallpapers = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`room-${index}`, 'gradient1']));
    expect(userChatSettingsSchema.safeParse({ roomWallpapers: tooManyWallpapers }).success).toBe(false);

    const appearance = {
      overlayOpacity: 0.5,
      overlayBlur: 0,
      ownBubbleColor: '#ffffff',
      ownBubbleOpacity: 1,
      ownTextIntensity: null,
      otherBubbleColor: null,
      otherBubbleOpacity: 1,
      otherTextIntensity: null,
      bubbleBlur: 0,
    };
    const tooManyAppearances = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`room-${index}`, appearance]));
    expect(userChatSettingsSchema.safeParse({ roomAppearance: tooManyAppearances }).success).toBe(false);
  });

  it('still fits the largest accepted chat settings inside one socket frame', () => {
    const appearance = {
      overlayOpacity: 0.123456789,
      overlayBlur: 12.3456789,
      ownBubbleColor: 'x'.repeat(100),
      ownBubbleOpacity: 0.123456789,
      ownTextIntensity: 0.123456789,
      otherBubbleColor: 'x'.repeat(100),
      otherBubbleOpacity: 0.123456789,
      otherTextIntensity: 0.123456789,
      bubbleBlur: 12.3456789,
    };
    const settings = {
      roomWallpapers: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`${ID}-${index}`, 'x'.repeat(100)])),
      globalWallpaper: 'x'.repeat(100),
      roomAppearance: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`${ID}-${index}`, appearance])),
      globalAppearance: appearance,
    };

    expect(userChatSettingsSchema.safeParse(settings).success).toBe(true);
    expect(Buffer.byteLength(`42${JSON.stringify(['user:update-chat-settings', settings])}`)).toBeLessThan(SOCKET_MAX_HTTP_BUFFER_SIZE);
  });
});

describe('per-user aggregate budgets and connection caps', () => {
  it('shares one budget between all sockets of a user', async () => {
    const budgets = { events: { 'rooms:get': { capacity: 2, refillPerSecond: 0 } }, fallback: { capacity: 100, refillPerSecond: 0 } };
    const h = await start({ socketEventBudgets: budgets });
    const account = await h.createAccount('SharedBudget');
    const clients = await Promise.all(Array.from({ length: 4 }, () => h.connectAs(account)));
    const errors = clients.map((client) => collectEvents<ErrorEvent>(client, 'error'));

    for (const client of clients) {
      for (let i = 0; i < 2; i += 1) {
        client.emit('rooms:get');
      }
    }
    await settle();

    const limited = errors.flat().filter((error) => error.code === 'rateLimit.socket');
    expect(limited.length).toBeGreaterThan(0);
  });

  it('does not let one user exhaust the budget of another', async () => {
    const budgets = { events: { 'rooms:get': { capacity: 1, refillPerSecond: 0 } }, fallback: { capacity: 100, refillPerSecond: 0 } };
    const h = await start({ socketEventBudgets: budgets });
    const noisy = await h.connectAs(await h.createAccount('NoisyUser'));
    const quiet = await h.connectAs(await h.createAccount('QuietUser'));
    const quietErrors = collectEvents<ErrorEvent>(quiet, 'error');

    for (let i = 0; i < 10; i += 1) {
      noisy.emit('rooms:get');
    }
    quiet.emit('rooms:get');
    await settle();

    expect(quietErrors.filter((error) => error.code === 'rateLimit.socket')).toHaveLength(0);
  });

  it('closes the oldest socket when a user exceeds the per-user cap', async () => {
    const h = await start({ socketConnectionLimits: { maxPerIp: 100, maxPerUser: 3, unauthenticatedTimeoutMs: 0 } });
    const account = await h.createAccount('ManySockets');
    const first = await h.connectAs(account);
    const second = await h.connectAs(account);
    const third = await h.connectAs(account);
    const dropped = waitForDisconnect(first);

    const fourth = await h.connectAs(account);
    await dropped;

    expect(first.connected).toBe(false);
    expect([second.connected, third.connected, fourth.connected]).toEqual([true, true, true]);
  });

  it('rejects connections above the per-address cap and frees slots on disconnect', async () => {
    const h = await start({ socketConnectionLimits: { maxPerIp: 2, maxPerUser: 10, unauthenticatedTimeoutMs: 0 } });
    const first = await h.connect();
    await h.connect();
    const third = await h.connect();
    await waitForDisconnect(third);
    expect(third.connected).toBe(false);

    first.disconnect();
    await settle();
    const fourth = await h.connect();
    await settle();

    expect(fourth.connected).toBe(true);
  });

  it('closes transports that never authenticate and lets them reconnect', async () => {
    const h = await start({ socketConnectionLimits: { maxPerIp: 100, maxPerUser: 10, unauthenticatedTimeoutMs: 150 } });
    const idle = await h.connect();
    const authenticated = await h.connectAs(await h.createAccount('Authenticated'));

    await expect(waitForDisconnect(idle, 2000)).resolves.toBe('transport close');
    await settle();

    expect(authenticated.connected).toBe(true);
  });
});
