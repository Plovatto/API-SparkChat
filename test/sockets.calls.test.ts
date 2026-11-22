import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { users } from '@/database/schema.js';
import { monthKey } from '@/modules/calls/call-budget.js';
import { CallBudget, CallRateLimiter, CallService } from '@/modules/calls/index.js';
import type { TurnCredential, TurnProvider } from '@/modules/calls/turn-credentials.js';
import { collectEvents, settle, startSocketHarness, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

interface ErrorEvent {
  code: string;
  event?: string;
}

interface CallEndedEvent {
  callId: string;
  reason: string;
  endedAt: string;
}

const ENVELOPE = 'opaque-envelope';

let harness: Harness | null = null;
const clock = { now: Date.UTC(2026, 5, 15, 12, 0, 0) };

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function newCallId(): string {
  return randomBytes(16).toString('base64url');
}

interface FakeTurn extends TurnProvider {
  failGenerate: boolean;
  failRevoke: boolean;
  holdNextRevoke: Promise<void> | null;
  generated: number;
  revoked: string[];
  generateSpy: ReturnType<typeof vi.fn<(ttlSeconds: number) => void>>;
}

function fakeTurn(): FakeTurn {
  const turn: FakeTurn = {
    failGenerate: false,
    failRevoke: false,
    holdNextRevoke: null,
    generated: 0,
    revoked: [],
    generateSpy: vi.fn<(ttlSeconds: number) => void>(),
    generate(ttlSeconds: number): Promise<TurnCredential> {
      turn.generateSpy(ttlSeconds);
      if (turn.failGenerate) {
        return Promise.reject(new Error('cloudflare down'));
      }
      turn.generated += 1;
      const username = `turn-user-${turn.generated}`;
      return Promise.resolve({
        username,
        iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478'], username, credential: `secret-${turn.generated}` }],
      });
    },
    async revoke(username: string): Promise<void> {
      const hold = turn.holdNextRevoke;
      turn.holdNextRevoke = null;
      if (hold) {
        await hold;
      }
      if (turn.failRevoke) {
        throw new Error('cloudflare down');
      }
      turn.revoked.push(username);
    },
  };
  return turn;
}

async function setup(options: { turn?: FakeTurn; enabled?: boolean; hiddenRoom?: boolean } = {}) {
  clock.now = Date.UTC(2026, 5, 15, 12, 0, 0);
  const h = await startSocketHarness({
    calls: { now: () => clock.now, ...(options.turn ? { turnProvider: options.turn } : {}), ...(options.enabled === undefined ? {} : { enabled: options.enabled }) },
  });
  harness = h;
  const alice = await h.createAccount('Alice');
  const bob = await h.createAccount('Bobby');
  const carol = await h.createAccount('Carol');
  const room = await h.roomService.createPrivateRoom(alice.user.id, bob.user.id);
  if (!options.hiddenRoom) {
    await h.roomService.makeVisibleForAll(room, new Date().toISOString());
  }
  const aliceClient = await h.connectAs(alice);
  const bobClient = await h.connectAs(bob);
  return { h, alice, bob, carol, room, aliceClient, bobClient };
}

async function beat(client: TestClient, callId: string, relayed: boolean): Promise<void> {
  client.emit('call:heartbeat', { callId, relayed });
  const synced = waitForEvent(client, 'call:state');
  client.emit('call:sync', {});
  await synced;
}

function expectError(client: TestClient, event: string): Promise<ErrorEvent> {
  return waitForEvent<ErrorEvent>(client, 'error', (payload) => payload.event === event);
}

async function ring(
  _h: Harness,
  caller: TestClient,
  callee: TestClient[],
  roomId: string,
  kind: 'voice' | 'video' = 'voice',
): Promise<string> {
  const callId = newCallId();
  const incoming = Promise.all(callee.map((client) => waitForEvent(client, 'call:incoming')));
  caller.emit('call:start', { callId, roomId, kind, envelope: ENVELOPE });
  await incoming;
  return callId;
}

async function answer(caller: TestClient, callee: TestClient, callId: string): Promise<void> {
  const accepted = Promise.all([waitForEvent(caller, 'call:accepted'), waitForEvent(callee, 'call:accepted')]);
  callee.emit('call:accept', { callId, envelope: 'accept-envelope' });
  await accepted;
}

async function callRow(h: Harness, callId: string) {
  const row = await h.callRepository.findById(callId);
  if (!row) {
    throw new Error('call row missing');
  }
  return row;
}

async function systemEventTypes(h: Harness, roomId: string): Promise<string[]> {
  const messages = await h.messageService.getRoomMessages(roomId);
  return messages.flatMap((message) => (message.systemEvent ? [message.systemEvent.type] : []));
}

describe('call config', () => {
  it('announces the module and relay availability after auth', async () => {
    const h = await startSocketHarness({ calls: { turnProvider: fakeTurn() } });
    harness = h;
    const alice = await h.createAccount('Alice');
    const client = await h.connect();
    const config = waitForEvent(client, 'call:config');
    await h.resume(client, alice.user.id, alice.sessionToken);
    expect(await config).toEqual({ enabled: true, relayAvailable: true, degrade: 'none' });
  });

  it('reports the relay as unavailable without TURN credentials and refuses calls when disabled', async () => {
    const { h, alice, aliceClient, room } = await setup({ enabled: false });
    const other = await h.connect();
    const config = waitForEvent(other, 'call:config');
    await h.resume(other, alice.user.id, alice.sessionToken);
    expect(await config).toEqual({ enabled: false, relayAvailable: false, degrade: 'none' });

    const error = expectError(aliceClient, 'call:start');
    aliceClient.emit('call:start', { callId: newCallId(), roomId: room.id, kind: 'voice', envelope: ENVELOPE });
    expect((await error).code).toBe('call.disabled');

    const noTurn = await startSocketHarness();
    const user = await noTurn.createAccount('Dave');
    const client = await noTurn.connect();
    const noTurnConfig = waitForEvent(client, 'call:config');
    await noTurn.resume(client, user.user.id, user.sessionToken);
    expect(await noTurnConfig).toEqual({ enabled: true, relayAvailable: false, degrade: 'none' });
    await noTurn.close();
  });
});

describe('call authorization', () => {
  it('rings every device of the callee with the exact payload and not the caller', async () => {
    const { h, alice, bob, room, aliceClient, bobClient } = await setup();
    const bobTablet = await h.connectAs(bob);
    const callerEvents = collectEvents(aliceClient, 'call:incoming');
    const callId = newCallId();
    const phone = waitForEvent<Record<string, unknown>>(bobClient, 'call:incoming');
    const tablet = waitForEvent<Record<string, unknown>>(bobTablet, 'call:incoming');

    aliceClient.emit('call:start', { callId, roomId: room.id, kind: 'video', envelope: ENVELOPE });

    const expected = {
      callId,
      roomId: room.id,
      kind: 'video',
      callerId: alice.user.id,
      envelope: ENVELOPE,
      ringExpiresAt: new Date(clock.now + 45_000).toISOString(),
    };
    expect(await phone).toEqual(expected);
    expect(await tablet).toEqual(expected);
    await settle(50);
    expect(callerEvents).toHaveLength(0);
    expect((await callRow(h, callId)).state).toBe('ringing');
  });

  it('rejects non-members, group rooms, the assistant room, blocks and unknown rooms', async () => {
    const { h, alice, bob, carol, room, aliceClient } = await setup();
    const carolClient = await h.connectAs(carol);
    const group = await h.roomService.createGroupRoom(alice.user.id);
    await h.db.insert(users).values({
      id: 'spark-ai',
      nickname: 'Spark',
      nicknameNormalized: 'spark',
      avatar: 0,
      passwordHash: 'x',
      recoveryTokenHash: 'x',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });
    const aiRoom = await h.roomService.createPrivateRoom(alice.user.id, 'spark-ai');

    async function attempt(client: TestClient, roomId: string): Promise<string> {
      const error = expectError(client, 'call:start');
      client.emit('call:start', { callId: newCallId(), roomId, kind: 'voice', envelope: ENVELOPE });
      return (await error).code;
    }

    expect(await attempt(carolClient, room.id)).toBe('call.notAllowed');
    expect(await attempt(aliceClient, group.id)).toBe('call.notAllowed');
    expect(await attempt(aliceClient, aiRoom.id)).toBe('call.notAllowed');
    expect(await attempt(aliceClient, 'missing-room')).toBe('call.notAllowed');

    await h.roomService.blockUser(room.id, bob.user.id, alice.user.id);
    expect(await attempt(aliceClient, room.id)).toBe('call.notAllowed');
    expect(await h.callRepository.findOpen()).toHaveLength(0);
  });

  it('rejects a caller who blocked the callee', async () => {
    const { h, alice, bob, room, aliceClient } = await setup();
    await h.roomService.blockUser(room.id, alice.user.id, bob.user.id);
    const error = expectError(aliceClient, 'call:start');
    aliceClient.emit('call:start', { callId: newCallId(), roomId: room.id, kind: 'voice', envelope: ENVELOPE });
    expect((await error).code).toBe('call.notAllowed');
  });

  it('validates payload shape, call id format and reused call ids', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const invalid = expectError(aliceClient, 'call:start');
    aliceClient.emit('call:start', { callId: 'short', roomId: room.id, kind: 'voice', envelope: ENVELOPE });
    expect((await invalid).code).toBe('validation.invalidPayload');

    const wrongKind = expectError(aliceClient, 'call:start');
    aliceClient.emit('call:start', { callId: newCallId(), roomId: room.id, kind: 'screen', envelope: ENVELOPE });
    expect((await wrongKind).code).toBe('validation.invalidPayload');

    const callId = await ring(h, aliceClient, [bobClient], room.id);
    aliceClient.emit('call:hangup', { callId });
    await waitForEvent(aliceClient, 'call:ended');
    const reused = expectError(aliceClient, 'call:start');
    aliceClient.emit('call:start', { callId, roomId: room.id, kind: 'voice', envelope: ENVELOPE });
    expect((await reused).code).toBe('call.invalidState');
  });

  it('refuses oversized invite envelopes', async () => {
    const { room, aliceClient } = await setup();
    const error = expectError(aliceClient, 'call:start');
    aliceClient.emit('call:start', { callId: newCallId(), roomId: room.id, kind: 'voice', envelope: 'x'.repeat(16 * 1024 + 1) });
    expect((await error).code).toBe('call.signalTooLarge');
  });
});

describe('accept, decline and hangup', () => {
  it('lets the first accept win atomically across devices', async () => {
    const { h, bob, room, aliceClient, bobClient } = await setup();
    const bobTablet = await h.connectAs(bob);
    const callId = await ring(h, aliceClient, [bobClient, bobTablet], room.id);
    const accepted = collectEvents<{ callId: string; envelope: string; deviceId: string }>(aliceClient, 'call:accepted');
    const phoneAccepted = collectEvents(bobClient, 'call:accepted');
    const tabletAccepted = collectEvents(bobTablet, 'call:accepted');
    const phoneElsewhere = collectEvents(bobClient, 'call:answered-elsewhere');
    const tabletElsewhere = collectEvents(bobTablet, 'call:answered-elsewhere');

    bobClient.emit('call:accept', { callId, envelope: 'phone-envelope' });
    bobTablet.emit('call:accept', { callId, envelope: 'tablet-envelope' });
    await settle(300);

    expect(accepted).toHaveLength(1);
    const winnerIsPhone = phoneAccepted.length === 1;
    expect(phoneAccepted.length + tabletAccepted.length).toBe(1);
    expect(winnerIsPhone ? phoneElsewhere : tabletElsewhere).toHaveLength(0);
    expect(winnerIsPhone ? tabletElsewhere : phoneElsewhere).toEqual([{ callId }]);
    expect(accepted[0]).toEqual({
      callId,
      envelope: winnerIsPhone ? 'phone-envelope' : 'tablet-envelope',
      deviceId: winnerIsPhone ? bobClient.id : bobTablet.id,
    });
    const row = await callRow(h, callId);
    expect(row.state).toBe('accepted');
    expect(row.acceptedDeviceId).toBe(accepted[0]?.deviceId);
    expect(row.answeredAt).toBe(new Date(clock.now).toISOString());
  });

  it('only lets the callee accept, and not after the ring window', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);

    const notCallee = expectError(aliceClient, 'call:accept');
    aliceClient.emit('call:accept', { callId, envelope: ENVELOPE });
    expect((await notCallee).code).toBe('call.notAllowed');

    clock.now += 46_000;
    const late = expectError(bobClient, 'call:accept');
    bobClient.emit('call:accept', { callId, envelope: ENVELOPE });
    expect((await late).code).toBe('call.invalidState');
    expect((await callRow(h, callId)).endReason).toBe('missed');

    const unknown = expectError(bobClient, 'call:accept');
    bobClient.emit('call:accept', { callId: newCallId(), envelope: ENVELOPE });
    expect((await unknown).code).toBe('call.notFound');
  });

  it('declines for every device and records a missed call', async () => {
    const { h, bob, room, aliceClient, bobClient } = await setup();
    const bobTablet = await h.connectAs(bob);
    const callId = await ring(h, aliceClient, [bobClient, bobTablet], room.id);
    const callerEnded = waitForEvent<CallEndedEvent>(aliceClient, 'call:ended');
    const tabletDeclined = waitForEvent(bobTablet, 'call:declined-elsewhere');
    const tabletEnded = waitForEvent<CallEndedEvent>(bobTablet, 'call:ended');
    const phoneDeclinedElsewhere = collectEvents(bobClient, 'call:declined-elsewhere');

    bobClient.emit('call:decline', { callId });

    const ended = await callerEnded;
    expect(ended.reason).toBe('declined');
    expect(await tabletDeclined).toEqual({ callId });
    expect((await tabletEnded).reason).toBe('declined');
    expect(phoneDeclinedElsewhere).toHaveLength(0);
    expect(new Date(ended.endedAt).getTime()).toBe(clock.now);
    expect(await systemEventTypes(h, room.id)).toEqual(['call.missed']);
  });

  it('declines from the push notification with the call scoped token even with no socket of the callee involved', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const pushes = vi.spyOn(h.pushService, 'incomingCall');
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    const token = pushes.mock.calls[0]?.[0].declineToken;
    expect(typeof token).toBe('string');
    const callerEnded = waitForEvent<CallEndedEvent>(aliceClient, 'call:ended');
    const bobDeclined = waitForEvent(bobClient, 'call:declined-elsewhere');

    await expect(h.callService.declineWithToken({ callId: newCallId(), token: token as string })).rejects.toMatchObject({ code: 'call.notAllowed' });
    await expect(h.callService.declineWithToken({ callId, token: `${token as string}x` })).rejects.toMatchObject({ code: 'call.notAllowed' });
    await h.callService.declineWithToken({ callId, token: token as string });

    expect((await callerEnded).reason).toBe('declined');
    expect(await bobDeclined).toEqual({ callId });
    expect((await callRow(h, callId)).endReason).toBe('declined');
    await expect(h.callService.declineWithToken({ callId, token: token as string })).rejects.toMatchObject({ code: 'call.invalidState' });
  });

  it('refuses a push decline once the ring expired', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const pushes = vi.spyOn(h.pushService, 'incomingCall');
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    const token = pushes.mock.calls[0]?.[0].declineToken as string;
    clock.now += 46_000;

    await expect(h.callService.declineWithToken({ callId, token })).rejects.toMatchObject({ code: 'call.notAllowed' });
  });

  it('cancels while ringing and completes after answer with the duration in the system message', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const first = await ring(h, aliceClient, [bobClient], room.id);
    const cancelled = waitForEvent<CallEndedEvent>(bobClient, 'call:ended');
    aliceClient.emit('call:hangup', { callId: first });
    expect((await cancelled).reason).toBe('cancelled');

    const second = await ring(h, aliceClient, [bobClient], room.id, 'video');
    await answer(aliceClient, bobClient, second);
    clock.now += 125_000;
    const completed = waitForEvent<CallEndedEvent>(aliceClient, 'call:ended');
    bobClient.emit('call:hangup', { callId: second });
    expect((await completed).reason).toBe('completed');

    const messages = await h.messageService.getRoomMessages(room.id);
    const events = messages.flatMap((message) => (message.systemEvent ? [message.systemEvent] : []));
    expect(events.map((event) => event.type)).toEqual(['call.missed', 'call.ended']);
    expect(events[1]?.params).toMatchObject({ kind: 'video', durationSec: '125', reason: 'completed' });
    expect(messages.at(-1)?.content).toBe('Chamada de vídeo encerrada (2:05)');

    aliceClient.emit('call:hangup', { callId: second });
    await settle(100);
  });

  it('broadcasts the system message to the room', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const rooms = waitForEvent(aliceClient, 'rooms:list');
    aliceClient.emit('rooms:get');
    await rooms;
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    const message = waitForEvent<{ type: string; systemEvent: { type: string } }>(aliceClient, 'message:new');
    aliceClient.emit('call:hangup', { callId });
    expect((await message).systemEvent.type).toBe('call.missed');
  });

  it('reveals a room the callee has not opened before ringing, so a first-contact call can be matched to a local room', async () => {
    const { h, room, aliceClient, bobClient } = await setup({ hiddenRoom: true });
    const order: string[] = [];
    bobClient.on('room:new', () => order.push('room:new'));
    bobClient.on('call:incoming', () => order.push('call:incoming'));
    const revealed = waitForEvent<{ room: { id: string } }>(bobClient, 'room:new');
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    expect((await revealed).room.id).toBe(room.id);
    expect(order).toEqual(['room:new', 'call:incoming']);
    expect(room.id).toBeTruthy();
    expect((await h.roomService.getRoomById(room.id))?.visibleTo).toContain((await callRow(h, callId)).calleeId);
  });

  it('records a missed call in a room that was revealed by the ring', async () => {
    const { h, room, aliceClient, bobClient } = await setup({ hiddenRoom: true });
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    const ended = waitForEvent(bobClient, 'call:ended');
    aliceClient.emit('call:hangup', { callId });
    await ended;
    await vi.waitFor(async () => expect(await systemEventTypes(h, room.id)).toEqual(['call.missed']));
  });

  it('brings back a conversation the callee deleted when a call rings, like a message would', async () => {
    const { h, bob, room, aliceClient, bobClient } = await setup();
    await h.roomService.deleteForUser(room.id, bob.user.id);
    const revealed = waitForEvent<{ room: { id: string } }>(bobClient, 'room:new');
    await ring(h, aliceClient, [bobClient], room.id);
    expect((await revealed).room.id).toBe(room.id);
  });

  it('silence acknowledges without ending the call', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    const acked = await new Promise<boolean>((resolve) => {
      bobClient.emit('call:silence', { callId }, () => resolve(true));
    });
    expect(acked).toBe(true);
    expect((await callRow(h, callId)).state).toBe('ringing');

    const denied = expectError(aliceClient, 'call:silence');
    aliceClient.emit('call:silence', { callId });
    expect((await denied).code).toBe('call.notAllowed');
  });
});

describe('busy, simultaneous and rate limited calls', () => {
  it('answers busy to a caller when the callee is already talking', async () => {
    const { h, alice, bob, carol, room, bobClient } = await setup();
    const carolClient = await h.connectAs(carol);
    const bobCarol = await h.roomService.createPrivateRoom(carol.user.id, bob.user.id);
    const aliceClient2 = await h.connectAs(alice);
    const talking = await ring(h, carolClient, [bobClient], bobCarol.id);
    await answer(carolClient, bobClient, talking);

    const busyEnded = waitForEvent<CallEndedEvent>(aliceClient2, 'call:ended');
    const busyError = expectError(aliceClient2, 'call:start');
    const callId = newCallId();
    aliceClient2.emit('call:start', { callId, roomId: room.id, kind: 'voice', envelope: ENVELOPE });

    expect((await busyError).code).toBe('call.peerBusy');
    expect(await busyEnded).toMatchObject({ callId, reason: 'busy' });
    const row = await callRow(h, callId);
    expect(row.state).toBe('ended');
    expect(row.endReason).toBe('busy');
    expect(await systemEventTypes(h, room.id)).toEqual(['call.missed']);
    expect((await callRow(h, talking)).state).toBe('accepted');
  });

  it('allows one active call per user', async () => {
    const { h, alice, carol, room, aliceClient, bobClient } = await setup();
    const carolRoom = await h.roomService.createPrivateRoom(alice.user.id, carol.user.id);
    await ring(h, aliceClient, [bobClient], room.id);

    const error = expectError(aliceClient, 'call:start');
    aliceClient.emit('call:start', { callId: newCallId(), roomId: carolRoom.id, kind: 'voice', envelope: ENVELOPE });
    expect((await error).code).toBe('call.alreadyInCall');
  });

  it('keeps the first call when both sides ring each other', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const first = await ring(h, aliceClient, [bobClient], room.id);

    const error = expectError(bobClient, 'call:start');
    bobClient.emit('call:start', { callId: newCallId(), roomId: room.id, kind: 'voice', envelope: ENVELOPE });
    expect((await error).code).toBe('call.alreadyInCall');

    const open = await h.callRepository.findOpen();
    expect(open.map((call) => call.id)).toEqual([first]);
    await answer(aliceClient, bobClient, first);
  });

  it('rate limits starts per pair and per caller', async () => {
    const { h, alice, carol, room, aliceClient, bobClient } = await setup();
    const carolClient = await h.connectAs(carol);

    for (let i = 0; i < 3; i += 1) {
      const callId = await ring(h, aliceClient, [bobClient], room.id);
      aliceClient.emit('call:hangup', { callId });
      await waitForEvent(bobClient, 'call:ended');
    }

    const limited = expectError(aliceClient, 'call:start');
    aliceClient.emit('call:start', { callId: newCallId(), roomId: room.id, kind: 'voice', envelope: ENVELOPE });
    expect((await limited).code).toBe('call.rateLimited');

    const carolRoom = await h.roomService.createPrivateRoom(alice.user.id, carol.user.id);
    for (let i = 0; i < 2; i += 1) {
      const callId = await ring(h, aliceClient, [carolClient], carolRoom.id);
      aliceClient.emit('call:hangup', { callId });
      await waitForEvent(carolClient, 'call:ended');
    }
    const callerLimited = expectError(aliceClient, 'call:start');
    aliceClient.emit('call:start', { callId: newCallId(), roomId: carolRoom.id, kind: 'voice', envelope: ENVELOPE });
    expect((await callerLimited).code).toBe('call.rateLimited');

    clock.now += 61_000;
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    expect((await callRow(h, callId)).state).toBe('ringing');
  });
});

describe('signaling', () => {
  it('only relays after accept, to the accepted device, with exact payload', async () => {
    const { h, alice, bob, room, aliceClient, bobClient } = await setup();
    const bobTablet = await h.connectAs(bob);
    const callId = await ring(h, aliceClient, [bobClient, bobTablet], room.id);

    const early = expectError(aliceClient, 'call:signal');
    aliceClient.emit('call:signal', { callId, to: bob.user.id, envelope: 'offer' });
    expect((await early).code).toBe('call.invalidState');

    await answer(aliceClient, bobClient, callId);
    const tabletSignals = collectEvents(bobTablet, 'call:signal');
    const received = waitForEvent(bobClient, 'call:signal');
    aliceClient.emit('call:signal', { callId, to: bob.user.id, envelope: 'offer' });
    expect(await received).toEqual({ callId, from: alice.user.id, envelope: 'offer' });

    const back = waitForEvent(aliceClient, 'call:signal');
    bobClient.emit('call:signal', { callId, to: alice.user.id, envelope: 'answer' });
    expect(await back).toEqual({ callId, from: bob.user.id, envelope: 'answer' });
    await settle(100);
    expect(tabletSignals).toHaveLength(0);
    expect((await callRow(h, callId)).state).toBe('active');
  });

  it('rejects signals from other devices, to wrong peers, from strangers and oversized ones', async () => {
    const { h, alice, bob, carol, room, aliceClient, bobClient } = await setup();
    const bobTablet = await h.connectAs(bob);
    const carolClient = await h.connectAs(carol);
    const callId = await ring(h, aliceClient, [bobClient, bobTablet], room.id);
    await answer(aliceClient, bobClient, callId);
    const bobSignals = collectEvents(bobClient, 'call:signal');

    async function expectCode(client: TestClient, payload: { to: string; envelope: string }): Promise<string> {
      const error = expectError(client, 'call:signal');
      client.emit('call:signal', { callId, ...payload });
      return (await error).code;
    }

    expect(await expectCode(bobTablet, { to: alice.user.id, envelope: 'x' })).toBe('call.notAllowed');
    expect(await expectCode(carolClient, { to: alice.user.id, envelope: 'x' })).toBe('call.notAllowed');
    expect(await expectCode(aliceClient, { to: carol.user.id, envelope: 'x' })).toBe('call.notAllowed');
    expect(await expectCode(aliceClient, { to: alice.user.id, envelope: 'x' })).toBe('call.notAllowed');
    expect(await expectCode(aliceClient, { to: bob.user.id, envelope: 'x'.repeat(16 * 1024 + 1) })).toBe('call.signalTooLarge');

    const maxSize = waitForEvent(bobClient, 'call:signal');
    aliceClient.emit('call:signal', { callId, to: bob.user.id, envelope: 'x'.repeat(16 * 1024) });
    expect((await maxSize) as { envelope: string }).toMatchObject({ callId });
    expect(bobSignals).toHaveLength(1);
  });

  it('limits the signal rate per call', async () => {
    const { room, h, bob, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const delivered = collectEvents(bobClient, 'call:signal');
    const errors = collectEvents<ErrorEvent>(aliceClient, 'error');

    for (let i = 0; i < 80; i += 1) {
      aliceClient.emit('call:signal', { callId, to: bob.user.id, envelope: `c${i}` });
    }
    await settle(500);

    expect(delivered).toHaveLength(60);
    expect(errors.filter((error) => error.code === 'call.rateLimited')).toHaveLength(20);
  });
});

describe('TURN credentials', () => {
  it('issues nothing before accept and one credential per request after it', async () => {
    const turn = fakeTurn();
    const { h, room, aliceClient, bobClient } = await setup({ turn });
    const callId = await ring(h, aliceClient, [bobClient], room.id);

    const early = expectError(bobClient, 'call:ice-servers');
    bobClient.emit('call:ice-servers', { callId, protectIp: false });
    expect((await early).code).toBe('call.invalidState');
    expect(turn.generateSpy).not.toHaveBeenCalled();

    await answer(aliceClient, bobClient, callId);
    const result = waitForEvent<Record<string, unknown>>(aliceClient, 'call:ice-servers-result');
    aliceClient.emit('call:ice-servers', { callId, protectIp: true });
    const issued = await result;

    expect(turn.generateSpy).toHaveBeenCalledWith(3_600);
    expect(issued).toEqual({
      callId,
      iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478'], username: 'turn-user-1', credential: 'secret-1' }],
      expiresAt: new Date(clock.now + 3_600_000).toISOString(),
      relayOnly: true,
      degrade: 'none',
    });
    const row = await callRow(h, callId);
    expect(row.turnUsername).toBe('turn-user-1');
    expect(row.relayUsed).toBe(1);

    const direct = waitForEvent<{ relayOnly: boolean }>(bobClient, 'call:ice-servers-result');
    bobClient.emit('call:ice-servers', { callId, protectIp: false });
    expect((await direct).relayOnly).toBe(false);
    expect((await callRow(h, callId)).calleeTurnUsername).toBe('turn-user-2');

    const spam = expectError(aliceClient, 'call:ice-servers');
    aliceClient.emit('call:ice-servers', { callId, protectIp: true });
    expect((await spam).code).toBe('call.rateLimited');
  });

  it('refuses strangers and ended calls', async () => {
    const turn = fakeTurn();
    const { h, carol, room, aliceClient, bobClient } = await setup({ turn });
    const carolClient = await h.connectAs(carol);
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);

    const stranger = expectError(carolClient, 'call:ice-servers');
    carolClient.emit('call:ice-servers', { callId, protectIp: false });
    expect((await stranger).code).toBe('call.notAllowed');

    aliceClient.emit('call:hangup', { callId });
    await waitForEvent(bobClient, 'call:ended');
    const late = expectError(bobClient, 'call:ice-servers');
    bobClient.emit('call:ice-servers', { callId, protectIp: false });
    expect((await late).code).toBe('call.invalidState');
    expect(turn.generated).toBe(0);
  });

  it('falls back to STUN only when Cloudflare fails, and refuses relay-only requests', async () => {
    const turn = fakeTurn();
    turn.failGenerate = true;
    const { h, room, aliceClient, bobClient } = await setup({ turn });
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);

    const stun = waitForEvent<Record<string, unknown>>(aliceClient, 'call:ice-servers-result');
    aliceClient.emit('call:ice-servers', { callId, protectIp: false });
    expect(await stun).toMatchObject({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], relayOnly: false });

    const refused = expectError(bobClient, 'call:ice-servers');
    bobClient.emit('call:ice-servers', { callId, protectIp: true });
    expect((await refused).code).toBe('call.relayUnavailable');
    expect((await callRow(h, callId)).relayUsed).toBe(0);
  });

  it('stops issuing relay credentials to a user who already relayed more than the daily allowance', async () => {
    const turn = fakeTurn();
    const { h, room, aliceClient, bobClient } = await setup({ turn });
    const first = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, first);
    const issued = waitForEvent<Record<string, unknown>>(aliceClient, 'call:ice-servers-result');
    aliceClient.emit('call:ice-servers', { callId: first, protectIp: true });
    expect(await issued).toMatchObject({ relayOnly: true });

    clock.now += 7 * 60 * 60 * 1000;
    const ended = waitForEvent(aliceClient, 'call:ended');
    aliceClient.emit('call:hangup', { callId: first });
    await ended;

    const second = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, second);
    const refused = expectError(aliceClient, 'call:ice-servers');
    aliceClient.emit('call:ice-servers', { callId: second, protectIp: true });
    expect((await refused).code).toBe('call.relayUnavailable');
    expect(turn.generated).toBe(1);

    clock.now += 18 * 60 * 60 * 1000;
    const ended2 = waitForEvent(aliceClient, 'call:ended');
    aliceClient.emit('call:hangup', { callId: second });
    await ended2;
    const third = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, third);
    const again = waitForEvent<Record<string, unknown>>(aliceClient, 'call:ice-servers-result');
    aliceClient.emit('call:ice-servers', { callId: third, protectIp: true });
    expect(await again).toMatchObject({ relayOnly: true });
  });

  it('serves STUN only when no TURN provider is configured', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);

    const stun = waitForEvent<Record<string, unknown>>(aliceClient, 'call:ice-servers-result');
    aliceClient.emit('call:ice-servers', { callId, protectIp: false });
    expect(await stun).toMatchObject({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], relayOnly: false });

    const refused = expectError(bobClient, 'call:ice-servers');
    bobClient.emit('call:ice-servers', { callId, protectIp: true });
    expect((await refused).code).toBe('call.relayUnavailable');
  });

  it.each([
    [0.6, 'video-360', true],
    [0.8, 'audio-only-relay', true],
    [0.95, 'audio-only-relay', false],
  ])('applies the budget step at %s of the free tier', async (ratio, degrade, relayAvailable) => {
    const turn = fakeTurn();
    const { h, room, aliceClient, bobClient } = await setup({ turn });
    await h.callRepository.addUsage(monthKey(clock.now), Math.round(ratio * 1_000_000_000_000));
    h.callBudget.invalidate();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);

    expect(await h.callService.getConfig()).toEqual({ enabled: true, relayAvailable, degrade });

    if (relayAvailable) {
      const result = waitForEvent<Record<string, unknown>>(aliceClient, 'call:ice-servers-result');
      aliceClient.emit('call:ice-servers', { callId, protectIp: true });
      expect(await result).toMatchObject({ degrade, relayOnly: true });
      return;
    }

    const refused = expectError(aliceClient, 'call:ice-servers');
    aliceClient.emit('call:ice-servers', { callId, protectIp: true });
    expect((await refused).code).toBe('call.relayUnavailable');
    const stun = waitForEvent<Record<string, unknown>>(bobClient, 'call:ice-servers-result');
    bobClient.emit('call:ice-servers', { callId, protectIp: false });
    expect(await stun).toMatchObject({ relayOnly: false, degrade, iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] });
    expect(turn.generateSpy).not.toHaveBeenCalled();
  });

  it('counts live relayed calls against the budget and stores the estimate when they end', async () => {
    const turn = fakeTurn();
    const { h, room, aliceClient, bobClient } = await setup({ turn });
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const issued = waitForEvent(aliceClient, 'call:ice-servers-result');
    aliceClient.emit('call:ice-servers', { callId, protectIp: false });
    await issued;

    clock.now += 3_600_000;
    h.callBudget.invalidate();
    expect((await h.callBudget.snapshot()).usedBytes).toBe(675_000_000);

    await h.callRepository.touchHeartbeat(callId, new Date(clock.now).toISOString());
    const ended = waitForEvent(bobClient, 'call:ended');
    aliceClient.emit('call:hangup', { callId });
    await ended;

    expect(await h.callRepository.getUsage(monthKey(clock.now))).toBe(675_000_000);
    h.callBudget.invalidate();
    expect((await h.callBudget.snapshot()).usedBytes).toBe(675_000_000);
  });

  it('drops relay credentials as soon as a device reports a direct route, so a long direct call costs nothing', async () => {
    const turn = fakeTurn();
    const { h, alice, room, aliceClient, bobClient } = await setup({ turn });
    const first = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, first);
    for (const client of [aliceClient, bobClient]) {
      const issued = waitForEvent(client, 'call:ice-servers-result');
      client.emit('call:ice-servers', { callId: first, protectIp: false });
      await issued;
    }
    clock.now += 3_000;
    for (const client of [aliceClient, bobClient]) {
      await beat(client, first, false);
    }
    expect(turn.revoked.sort()).toEqual(['turn-user-1', 'turn-user-2']);
    const row = await callRow(h, first);
    expect([row.turnUsername, row.calleeTurnUsername, row.callerRelaySince, row.calleeRelaySince]).toEqual([null, null, null, null]);
    expect([row.callerRelayMs, row.calleeRelayMs]).toEqual([3_000, 3_000]);

    clock.now += 7 * 60 * 60 * 1000;
    for (const client of [aliceClient, bobClient]) {
      await beat(client, first, false);
    }
    expect(turn.revoked).toHaveLength(2);
    h.callBudget.invalidate();
    expect((await h.callBudget.snapshot()).usedBytes).toBe(6 * 187_500);
    const ended = waitForEvent(bobClient, 'call:ended');
    aliceClient.emit('call:hangup', { callId: first });
    await ended;
    expect(await h.callRepository.getUsage(monthKey(clock.now))).toBe(6 * 187_500);
    expect(await h.callRepository.relaySecondsForUser(alice.user.id, '2000-01-01T00:00:00.000Z', new Date(clock.now).toISOString())).toBe(3);

    const second = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, second);
    const again = waitForEvent<Record<string, unknown>>(aliceClient, 'call:ice-servers-result');
    aliceClient.emit('call:ice-servers', { callId: second, protectIp: false });
    expect(await again).toMatchObject({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478'] }] });
  });

  it('counts every minute relay credentials are live, whatever the device claims, and reopens the window on a new request', async () => {
    const turn = fakeTurn();
    const { h, alice, bob, room, aliceClient, bobClient } = await setup({ turn });
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    for (const client of [aliceClient, bobClient]) {
      const issued = waitForEvent(client, 'call:ice-servers-result');
      client.emit('call:ice-servers', { callId, protectIp: false });
      await issued;
    }
    await beat(bobClient, callId, false);
    await beat(aliceClient, callId, true);
    clock.now += 35 * 60 * 1000;
    await beat(aliceClient, callId, true);
    h.callBudget.invalidate();
    expect((await h.callBudget.snapshot()).usedBytes).toBe(35 * 60 * 187_500);
    await beat(aliceClient, callId, false);
    clock.now += 20 * 60 * 1000;
    const reissued = waitForEvent(aliceClient, 'call:ice-servers-result');
    aliceClient.emit('call:ice-servers', { callId, protectIp: false });
    await reissued;
    clock.now += 5 * 60 * 1000;

    const ended = waitForEvent(bobClient, 'call:ended');
    aliceClient.emit('call:hangup', { callId });
    await ended;
    expect(await h.callRepository.getUsage(monthKey(clock.now))).toBe(40 * 60 * 187_500);
    expect(await h.callRepository.relaySecondsForUser(alice.user.id, '2000-01-01T00:00:00.000Z', new Date(clock.now).toISOString())).toBe(40 * 60);
    expect(await h.callRepository.relaySecondsForUser(bob.user.id, '2000-01-01T00:00:00.000Z', new Date(clock.now).toISOString())).toBe(0);
  });

  it('keeps counting while a revocation fails and keeps the username for the sweeper', async () => {
    const turn = fakeTurn();
    const { h, room, aliceClient, bobClient } = await setup({ turn });
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const issued = waitForEvent(aliceClient, 'call:ice-servers-result');
    aliceClient.emit('call:ice-servers', { callId, protectIp: false });
    await issued;
    turn.failRevoke = true;
    clock.now += 60_000;
    await beat(aliceClient, callId, false);
    const row = await callRow(h, callId);
    expect(row.turnUsername).toBe('turn-user-1');
    expect(row.callerRelaySince).not.toBeNull();
    h.callBudget.invalidate();
    expect((await h.callBudget.snapshot()).usedBytes).toBe(60 * 187_500);
  });

  it('keeps the window open and the new username when credentials are reissued while a direct route report is revoking the old ones', async () => {
    const turn = fakeTurn();
    const { h, alice, room, aliceClient, bobClient } = await setup({ turn });
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const issued = waitForEvent(aliceClient, 'call:ice-servers-result');
    aliceClient.emit('call:ice-servers', { callId, protectIp: false });
    await issued;
    const other = await h.connectAs(alice);
    const closing = vi.spyOn(h.callRepository, 'closeRelayWindow');
    let release = (): void => undefined;
    turn.holdNextRevoke = new Promise<void>((resolve) => {
      release = resolve;
    });
    clock.now += 20 * 60 * 1000;
    aliceClient.emit('call:heartbeat', { callId, relayed: false });
    await vi.waitFor(() => expect(turn.holdNextRevoke).toBeNull());
    const reissued = waitForEvent(other, 'call:ice-servers-result');
    other.emit('call:ice-servers', { callId, protectIp: false });
    await reissued;
    release();
    await vi.waitFor(() => expect(closing).toHaveBeenCalledTimes(1));
    expect(await closing.mock.results[0]?.value).toBe(false);
    const row = await callRow(h, callId);
    expect(row.turnUsername).toBe('turn-user-2');
    expect(row.callerRelaySince).not.toBeNull();
    expect(row.callerRelayMs).toBe(0);

    clock.now += 10 * 60 * 1000;
    const ended = waitForEvent(bobClient, 'call:ended');
    aliceClient.emit('call:hangup', { callId });
    await ended;
    expect(turn.revoked).toContain('turn-user-2');
    expect(await h.callRepository.getUsage(monthKey(clock.now))).toBe(30 * 60 * 187_500);
  });

  it('only closes a relay window when the stored usernames still match the ones that were revoked', async () => {
    const { h, alice, bob, room } = await setup();
    const callId = newCallId();
    const nowIso = new Date(clock.now).toISOString();
    await h.callRepository.insertIfBothFree({ id: callId, roomId: room.id, callerId: alice.user.id, calleeId: bob.user.id, kind: 'voice', createdAt: nowIso });
    await h.callRepository.accept(callId, bob.user.id, 'dev', nowIso, new Date(clock.now - 1000).toISOString());
    await h.callRepository.recordTurnIssued(callId, 'callee', 'u1', nowIso);
    await h.callRepository.recordTurnIssued(callId, 'callee', 'u2', new Date(clock.now + 1000).toISOString());
    const later = new Date(clock.now + 60_000).toISOString();

    expect(await h.callRepository.closeRelayWindow(callId, 'callee', later, 'u1', null)).toBe(false);
    let row = await callRow(h, callId);
    expect([row.calleeTurnUsername, row.calleeRelaySince, row.calleeRelayMs]).toEqual(['u2', nowIso, 0]);

    expect(await h.callRepository.closeRelayWindow(callId, 'callee', later, 'u2', null)).toBe(true);
    row = await callRow(h, callId);
    expect([row.calleeTurnUsername, row.calleeRelaySince, row.calleeRelayMs]).toEqual([null, null, 60_000]);
  });

  it('ignores a direct route report from a device that is not bound to the call', async () => {
    const turn = fakeTurn();
    const { h, alice, room, aliceClient, bobClient } = await setup({ turn });
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const issued = waitForEvent(aliceClient, 'call:ice-servers-result');
    aliceClient.emit('call:ice-servers', { callId, protectIp: false });
    await issued;
    const other = await h.connectAs(alice);
    const refused = expectError(other, 'call:heartbeat');
    other.emit('call:heartbeat', { callId, relayed: false });
    await refused;
    expect(turn.revoked).toHaveLength(0);
    expect((await callRow(h, callId)).turnUsername).toBe('turn-user-1');
  });

  it('revokes credentials when the call ends and retries failures in the sweeper', async () => {
    const turn = fakeTurn();
    const { h, room, aliceClient, bobClient } = await setup({ turn });
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    for (const client of [aliceClient, bobClient]) {
      const issued = waitForEvent(client, 'call:ice-servers-result');
      client.emit('call:ice-servers', { callId, protectIp: false });
      await issued;
    }

    turn.failRevoke = true;
    const ended = waitForEvent(bobClient, 'call:ended');
    aliceClient.emit('call:hangup', { callId });
    await ended;
    await settle(100);
    expect(turn.revoked).toEqual([]);
    expect((await callRow(h, callId)).turnRevokedAt).toBeNull();

    turn.failRevoke = false;
    await h.callService.runMaintenance();
    expect(turn.revoked.sort()).toEqual(['turn-user-1', 'turn-user-2']);
    expect((await callRow(h, callId)).turnRevokedAt).not.toBeNull();

    await h.callService.runMaintenance();
    expect(turn.revoked).toHaveLength(2);
  });

  it('revokes immediately on a clean end', async () => {
    const turn = fakeTurn();
    const { h, room, aliceClient, bobClient } = await setup({ turn });
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const issued = waitForEvent(bobClient, 'call:ice-servers-result');
    bobClient.emit('call:ice-servers', { callId, protectIp: false });
    await issued;

    const ended = waitForEvent(aliceClient, 'call:ended');
    bobClient.emit('call:hangup', { callId });
    await ended;
    await settle(100);

    expect(turn.revoked).toEqual(['turn-user-1']);
    expect((await callRow(h, callId)).turnRevokedAt).not.toBeNull();
  });
});

describe('server owned timers', () => {
  it('marks unanswered calls as missed after 45 seconds', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);

    clock.now += 44_000;
    await h.callService.runMaintenance();
    expect((await callRow(h, callId)).state).toBe('ringing');

    const callerEnded = waitForEvent<CallEndedEvent>(aliceClient, 'call:ended');
    const calleeEnded = waitForEvent<CallEndedEvent>(bobClient, 'call:ended');
    clock.now += 2000;
    await h.callService.runMaintenance();

    expect((await callerEnded).reason).toBe('missed');
    expect((await calleeEnded).reason).toBe('missed');
    expect(await systemEventTypes(h, room.id)).toEqual(['call.missed']);
  });

  it('ends calls whose heartbeat stopped and whose sockets are gone at the last heartbeat time and keeps beating calls alive', async () => {
    const { h, bob, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);

    clock.now += 70_000;
    aliceClient.emit('call:heartbeat', { callId });
    await settle(100);
    const lastBeat = new Date(clock.now).toISOString();

    aliceClient.disconnect();
    bobClient.disconnect();
    await settle(100);
    const watcher = await h.connectAs(bob);

    clock.now += 175_000;
    await h.callService.runMaintenance();
    expect((await callRow(h, callId)).state).toBe('accepted');

    const ended = waitForEvent<CallEndedEvent>(watcher, 'call:ended');
    clock.now += 6000;
    await h.callService.runMaintenance();
    const event = await ended;

    expect(event.reason).toBe('connection-lost');
    expect(event.endedAt).toBe(lastBeat);
    expect(await systemEventTypes(h, room.id)).toEqual(['call.ended']);
  });

  it('keeps a call alive while a bound socket stays connected even if explicit heartbeats are late', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);

    for (let minute = 0; minute < 10; minute += 1) {
      clock.now += 60_000;
      await h.callService.runMaintenance();
    }
    expect((await callRow(h, callId)).state).toBe('accepted');
  });

  it('counts the time a socket was last seen connected when the connection then drops', async () => {
    const { h, bob, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);

    clock.now += 300_000;
    await h.callService.runMaintenance();
    aliceClient.disconnect();
    bobClient.disconnect();
    await settle(100);
    const watcher = await h.connectAs(bob);

    clock.now += 170_000;
    await h.callService.runMaintenance();
    expect((await callRow(h, callId)).state).toBe('accepted');

    const ended = waitForEvent<CallEndedEvent>(watcher, 'call:ended');
    clock.now += 11_000;
    await h.callService.runMaintenance();
    expect((await ended).reason).toBe('connection-lost');
  });

  it('keeps the call when the last socket drops until the heartbeat expires', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);

    aliceClient.disconnect();
    bobClient.disconnect();
    await settle(200);
    expect((await callRow(h, callId)).state).toBe('accepted');

    clock.now += 150_000;
    await h.callService.runMaintenance();
    expect((await callRow(h, callId)).state).toBe('accepted');

    clock.now += 31_000;
    await h.callService.runMaintenance();
    expect((await callRow(h, callId)).endReason).toBe('connection-lost');
  });

  it('keeps a call with both sockets gone for as long as peerLive promises and lets either side resume it', async () => {
    const { h, alice, bob, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    aliceClient.emit('call:heartbeat', { callId });
    bobClient.emit('call:heartbeat', { callId });
    await settle(100);

    aliceClient.disconnect();
    bobClient.disconnect();
    await settle(100);
    clock.now += 170_000;
    await h.callService.runMaintenance();
    expect((await callRow(h, callId)).state).not.toBe('ended');

    const back = await h.connectAs(alice);
    const state = waitForEvent<{ callId: string; peerLive: boolean }>(back, 'call:state');
    back.emit('call:sync', { callId });
    expect(await state).toMatchObject({ callId, peerLive: true });
    const bobBack = await h.connectAs(bob);
    const bobState = waitForEvent<{ callId: string }>(bobBack, 'call:state');
    bobBack.emit('call:sync', { callId });
    expect((await bobState).callId).toBe(callId);
    const signal = waitForEvent<{ envelope: string }>(bobBack, 'call:signal');
    back.emit('call:signal', { callId, to: bob.user.id, envelope: 'both-back' });
    expect((await signal).envelope).toBe('both-back');
  });

});

describe('long calls', () => {
  it('keeps a healthy call past four hours while both participants stay connected', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    clock.now += 4 * 60 * 60 * 1000 + 1_000;
    await h.callService.runMaintenance();

    expect((await callRow(h, callId)).state).not.toBe('ended');
  });

  it('still ends a call past four hours once a participant is gone', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    bobClient.disconnect();
    await settle();
    clock.now += 4 * 60 * 60 * 1000 + 1_000;
    await h.callService.runMaintenance();

    expect((await callRow(h, callId)).endReason).toBe('completed');
  });
});

describe('abandoned calls', () => {
  it('lets a caller start a new call when both tabs of the previous call were closed', async () => {
    const { h, alice, bob, room, aliceClient, bobClient } = await setup();
    const first = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, first);
    aliceClient.disconnect();
    bobClient.disconnect();
    await settle();
    clock.now += 65_000;

    const alice2 = await h.connectAs(alice);
    const bob2 = await h.connectAs(bob);
    const second = await ring(h, alice2, [bob2], room.id);

    expect((await callRow(h, first)).state).toBe('ended');
    expect((await callRow(h, second)).state).toBe('ringing');
  });

  it('keeps refusing while the previous call still runs on another device of the caller', async () => {
    const { h, alice, room, aliceClient, bobClient } = await setup();
    const first = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, first);
    clock.now += 25_000;
    const tablet = await h.connectAs(alice);
    const refused = expectError(tablet, 'call:start');
    tablet.emit('call:start', { callId: newCallId(), roomId: room.id, kind: 'voice', envelope: ENVELOPE });

    expect((await refused).code).toBe('call.alreadyInCall');
  });

  it('never ends the dropped call of the callee because someone else calls them', async () => {
    const { h, alice, room, carol, aliceClient, bobClient } = await setup();
    const first = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, first);
    aliceClient.disconnect();
    bobClient.disconnect();
    await settle();
    clock.now += 65_000;
    const carolRoom = await h.roomService.createPrivateRoom(carol.user.id, alice.user.id);
    await h.roomService.makeVisibleForAll(carolRoom, new Date().toISOString());
    const carolClient = await h.connectAs(carol);
    const ended = waitForEvent<CallEndedEvent>(carolClient, 'call:ended');
    carolClient.emit('call:start', { callId: newCallId(), roomId: carolRoom.id, kind: 'voice', envelope: ENVELOPE });

    expect((await ended).reason).toBe('busy');
    expect((await callRow(h, first)).state).not.toBe('ended');
  });

  it('keeps a call that was just left for a reload so the same tab can still resume it', async () => {
    const { h, alice, room, aliceClient, bobClient } = await setup();
    const first = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, first);
    aliceClient.disconnect();
    await settle();
    const reloaded = await h.connectAs(alice);
    const refused = expectError(reloaded, 'call:start');
    reloaded.emit('call:start', { callId: newCallId(), roomId: room.id, kind: 'voice', envelope: ENVELOPE });

    expect((await refused).code).toBe('call.alreadyInCall');
    expect((await callRow(h, first)).state).not.toBe('ended');
  });
});

describe('same tab on a new socket', () => {
  const TAB_A = 'tab-alice-0123456789abcdef';
  const TAB_B = 'tab-bobby-0123456789abcdef';

  async function liveCall() {
    const ctx = await setup();
    const { room, aliceClient, bobClient } = ctx;
    const callId = newCallId();
    const incoming = waitForEvent(bobClient, 'call:incoming');
    aliceClient.emit('call:start', { callId, roomId: room.id, kind: 'voice', envelope: ENVELOPE, device: TAB_A });
    await incoming;
    const accepted = Promise.all([waitForEvent(aliceClient, 'call:accepted'), waitForEvent(bobClient, 'call:accepted')]);
    bobClient.emit('call:accept', { callId, envelope: 'accept-envelope', device: TAB_B });
    await accepted;
    return { ...ctx, callId };
  }

  it('rebinds the same tab right away after a network switch while the old socket still looks connected', async () => {
    const { h, alice, bob, callId, aliceClient } = await liveCall();
    const switched = await h.connectAs(bob);
    const state = waitForEvent(switched, 'call:state');
    switched.emit('call:sync', { callId, device: TAB_B });
    await state;

    const relayed = waitForEvent<{ envelope: string }>(switched, 'call:signal');
    aliceClient.emit('call:signal', { callId, to: bob.user.id, envelope: 'restart-offer' });
    expect((await relayed).envelope).toBe('restart-offer');

    const back = waitForEvent<{ envelope: string }>(aliceClient, 'call:signal');
    switched.emit('call:signal', { callId, to: alice.user.id, envelope: 'restart-answer' });
    expect((await back).envelope).toBe('restart-answer');
  });

  it('keeps the binding when another tab of the same account presents a different tab token', async () => {
    const { h, alice, bob, callId } = await liveCall();
    const other = await h.connectAs(bob);
    const state = waitForEvent(other, 'call:state');
    other.emit('call:sync', { callId, device: 'tab-other-0123456789abcdef' });
    await state;

    const refused = expectError(other, 'call:signal');
    other.emit('call:signal', { callId, to: alice.user.id, envelope: 'x' });
    expect((await refused).code).toBe('call.notAllowed');
  });

  it('marks the call resumable for the same tab after a reload and not for another tab', async () => {
    const { h, bob, callId, bobClient } = await liveCall();
    bobClient.disconnect();
    await settle();
    const reloaded = await h.connectAs(bob);
    const state = waitForEvent<{ transferable: boolean; resumable?: boolean }>(reloaded, 'call:state');
    reloaded.emit('call:sync', { callId: null, device: TAB_B });
    expect(await state).toMatchObject({ callId, transferable: true, resumable: true });

    const stranger = await h.connectAs(bob);
    const strangerState = waitForEvent<{ transferable: boolean; resumable?: boolean }>(stranger, 'call:state');
    stranger.emit('call:sync', { callId: null, device: 'tab-other-0123456789abcdef' });
    const seen = await strangerState;
    expect(seen.transferable).toBe(true);
    expect(seen.resumable).toBeUndefined();
  });

  it('does not mark the call resumable for a duplicated tab while the original tab is still connected', async () => {
    const { h, bob } = await liveCall();
    const duplicate = await h.connectAs(bob);
    const state = waitForEvent<{ resumable?: boolean }>(duplicate, 'call:state');
    duplicate.emit('call:sync', { callId: null, device: TAB_B });
    expect((await state).resumable).toBeUndefined();
  });

  it('drops queued signals once the silent socket beats again so they are not delivered twice', async () => {
    const { h, bob, callId, aliceClient, bobClient } = await liveCall();
    clock.now += 16_000;
    aliceClient.emit('call:signal', { callId, to: bob.user.id, envelope: 'offer-once' });
    await settle();
    await beat(bobClient, callId, false);
    const switched = await h.connectAs(bob);
    const late = collectEvents(switched, 'call:signal');
    const state = waitForEvent(switched, 'call:state');
    switched.emit('call:sync', { callId, device: TAB_B });
    await state;
    await settle();
    expect(late).toHaveLength(0);
  });

  it('keeps signals for a bound socket that went silent and delivers them when the tab comes back', async () => {
    const { h, bob, callId, aliceClient } = await liveCall();
    clock.now += 16_000;
    aliceClient.emit('call:signal', { callId, to: bob.user.id, envelope: 'lost-offer' });
    await settle();
    const switched = await h.connectAs(bob);
    const flushed = waitForEvent<{ envelope: string }>(switched, 'call:signal');
    switched.emit('call:sync', { callId, device: TAB_B });
    expect((await flushed).envelope).toBe('lost-offer');
  });
});

describe('call sync and restart restore', () => {
  it('always sends the config before the state on sync', async () => {
    const { aliceClient } = await setup();
    const order: string[] = [];
    aliceClient.on('call:config', () => order.push('config'));
    aliceClient.on('call:state', () => order.push('state'));
    const config = waitForEvent(aliceClient, 'call:config');
    const state = waitForEvent(aliceClient, 'call:state');
    aliceClient.emit('call:sync', {});
    expect(await config).toEqual({ enabled: true, relayAvailable: false, degrade: 'none' });
    await state;
    expect(order).toEqual(['config', 'state']);
  });

  it('sends the disabled config on sync when calls are off', async () => {
    const { aliceClient } = await setup({ enabled: false });
    const config = waitForEvent(aliceClient, 'call:config');
    aliceClient.emit('call:sync', {});
    expect(await config).toEqual({ enabled: false, relayAvailable: false, degrade: 'none' });
  });

  it('answers null when there is no call', async () => {
    const { aliceClient } = await setup();
    const state = waitForEvent(aliceClient, 'call:state');
    aliceClient.emit('call:sync', {});
    expect(await state).toBeNull();
  });

  it('restores an active call on a new socket and routes signals to it', async () => {
    const { h, alice, bob, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id, 'video');
    await answer(aliceClient, bobClient, callId);

    aliceClient.disconnect();
    const reloaded = await h.connectAs(alice);
    const state = waitForEvent(reloaded, 'call:state');
    reloaded.emit('call:sync', {});
    expect(await state).toEqual({ callId, state: 'accepted', roomId: room.id, kind: 'video', peerId: bob.user.id, role: 'caller', answeredAt: (await callRow(h, callId)).answeredAt, transferable: false, peerLive: true });

    const signal = waitForEvent(reloaded, 'call:signal');
    bobClient.emit('call:signal', { callId, to: alice.user.id, envelope: 'answer' });
    expect(await signal).toEqual({ callId, from: bob.user.id, envelope: 'answer' });

    const calleeState = waitForEvent(bobClient, 'call:state');
    bobClient.emit('call:sync', {});
    expect(await calleeState).toMatchObject({ role: 'callee', peerId: alice.user.id, kind: 'video' });
  });

  it('reports a ringing call to the caller and the callee', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    const state = waitForEvent<{ state: string; role: string }>(bobClient, 'call:state');
    bobClient.emit('call:sync', {});
    expect(await state).toMatchObject({ callId, state: 'ringing', role: 'callee' });
  });

  it('resends the ringing invite to a callee device that opens later, and not to the caller or after accept', async () => {
    const { h, bob, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id, 'video');

    const opened = await h.connectAs(bob);
    const resent = waitForEvent<{ callId: string; envelope: string; kind: string }>(opened, 'call:incoming');
    opened.emit('call:sync', {});
    expect(await resent).toMatchObject({ callId, envelope: ENVELOPE, kind: 'video' });

    const callerIncoming: unknown[] = [];
    aliceClient.on('call:incoming', (payload) => callerIncoming.push(payload));
    const callerState = waitForEvent(aliceClient, 'call:state');
    aliceClient.emit('call:sync', {});
    await callerState;

    await answer(aliceClient, opened, callId);
    const afterAccept: unknown[] = [];
    bobClient.on('call:incoming', (payload) => afterAccept.push(payload));
    const state = waitForEvent(bobClient, 'call:state');
    bobClient.emit('call:sync', {});
    await state;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callerIncoming).toEqual([]);
    expect(afterAccept).toEqual([]);
  });

  it('survives a server restart: state comes from the database and the heartbeat has a grace period', async () => {
    const { h, alice, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const restarted = new CallService(
      h.io,
      h.callRepository,
      h.roomService,
      h.messageService,
      new CallBudget(h.callRepository, () => clock.now),
      new CallRateLimiter(() => clock.now),
      null,
      { now: () => clock.now },
    );

    clock.now += 50_000;
    await restarted.runMaintenance();
    expect((await callRow(h, callId)).state).toBe('accepted');

    const state = waitForEvent(aliceClient, 'call:state');
    await restarted.sync({ userId: alice.user.id, socketId: aliceClient.id as string });
    expect(await state).toMatchObject({ callId, state: 'accepted', role: 'caller' });

    clock.now += 30_000;
    await restarted.runMaintenance();
    expect((await callRow(h, callId)).state).toBe('accepted');

    aliceClient.disconnect();
    bobClient.disconnect();
    await settle(100);
    clock.now += 190_000;
    await restarted.runMaintenance();
    expect((await callRow(h, callId)).endReason).toBe('connection-lost');
  });
});

describe('event ordering', () => {
  it('handles accept and an immediate ice-servers request in order even when the accept write is slow', async () => {
    const turn = fakeTurn();
    const { h, room, aliceClient, bobClient } = await setup({ turn });
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    const original = h.callRepository.accept.bind(h.callRepository);
    h.callRepository.accept = async (...args: Parameters<typeof original>) => {
      await settle(50);
      return original(...args);
    };
    const result = waitForEvent<{ iceServers: unknown[] }>(bobClient, 'call:ice-servers-result');
    const errors = collectEvents<ErrorEvent>(bobClient, 'error');

    bobClient.emit('call:accept', { callId, envelope: 'accept-envelope' });
    bobClient.emit('call:ice-servers', { callId, protectIp: false });

    expect((await result).iceServers.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    expect((await callRow(h, callId)).state).toBe('accepted');
  });

  it('keeps processing after a failing event and bounds the queue', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    const original = h.callRepository.findById.bind(h.callRepository);
    h.callRepository.findById = async (id: string) => {
      await settle(5);
      return original(id);
    };
    const errors = collectEvents<ErrorEvent>(bobClient, 'error');
    for (let i = 0; i < 100; i += 1) {
      bobClient.emit('call:signal', { callId: 'x'.repeat(22), to: 'x', envelope: 'e' });
    }
    await settle(400);
    expect(errors.some((error) => error.code === 'call.rateLimited')).toBe(true);
    expect(errors.some((error) => error.code === 'call.notFound')).toBe(true);

    const state = waitForEvent(bobClient, 'call:state');
    bobClient.emit('call:sync', {});
    expect(await state).toMatchObject({ callId });
  });
});

describe('hardening', () => {
  it('counts each device once from its first credential however often credentials are reissued', async () => {
    const turn = fakeTurn();
    const { h, room, aliceClient, bobClient } = await setup({ turn });
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);

    for (let i = 0; i < 3; i += 1) {
      const issued = waitForEvent(aliceClient, 'call:ice-servers-result');
      aliceClient.emit('call:ice-servers', { callId, protectIp: false });
      await issued;
      clock.now += 11_000;
      await h.callRepository.touchHeartbeat(callId, new Date(clock.now).toISOString());
    }
    const calleeIssued = waitForEvent(bobClient, 'call:ice-servers-result');
    bobClient.emit('call:ice-servers', { callId, protectIp: false });
    await calleeIssued;
    expect((await callRow(h, callId)).relayUsed).toBe(2);

    clock.now = Date.parse((await callRow(h, callId)).answeredAt as string) + 3_600_000;
    await h.callRepository.touchHeartbeat(callId, new Date(clock.now).toISOString());
    const ended = waitForEvent(bobClient, 'call:ended');
    aliceClient.emit('call:hangup', { callId });
    await ended;
    expect(await h.callRepository.getUsage(monthKey(clock.now))).toBe((3600 + 3600 - 33) * 187_500);
  });

  it('serves STUN only to a user who used more than twenty relayed hours this month', async () => {
    const turn = fakeTurn();
    const { h, alice, bob, room, aliceClient, bobClient } = await setup({ turn });
    const earlier = new Date(clock.now - 3_600_000 * 25).toISOString();
    const earlierEnd = new Date(clock.now - 3_600_000 * 4).toISOString();
    await h.callRepository.insertEnded({ id: newCallId(), roomId: room.id, callerId: alice.user.id, calleeId: bob.user.id, kind: 'voice', createdAt: earlier }, 'completed');
    await h.db.run(
      sql`UPDATE calls SET answered_at = ${earlier}, ended_at = ${earlierEnd}, turn_username = 'old', relay_used = 1, caller_relay_ms = ${21 * 3_600_000} WHERE state = 'ended'`,
    );
    clock.now += 60_000;
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);

    const refused = expectError(aliceClient, 'call:ice-servers');
    aliceClient.emit('call:ice-servers', { callId, protectIp: true });
    expect((await refused).code).toBe('call.relayUnavailable');
    clock.now += 11_000;
    const stun = waitForEvent<{ relayOnly: boolean }>(aliceClient, 'call:ice-servers-result');
    aliceClient.emit('call:ice-servers', { callId, protectIp: false });
    expect((await stun).relayOnly).toBe(false);
    expect(turn.generateSpy).not.toHaveBeenCalled();

    const other = waitForEvent(bobClient, 'call:ice-servers-result');
    bobClient.emit('call:ice-servers', { callId, protectIp: true });
    await other;
    expect(turn.generateSpy).toHaveBeenCalledTimes(1);
  });

  it('ends the call, records usage and marks revocation atomically when no provider exists', async () => {
    const { h, alice, bob, room } = await setup();
    const callId = newCallId();
    await h.callRepository.insertIfBothFree({ id: callId, roomId: room.id, callerId: alice.user.id, calleeId: bob.user.id, kind: 'voice', createdAt: new Date(clock.now).toISOString() });
    await h.callRepository.accept(callId, bob.user.id, 'dev', new Date(clock.now).toISOString(), new Date(clock.now - 1000).toISOString());
    await h.callRepository.recordTurnIssued(callId, 'caller', 'u1', new Date(clock.now).toISOString());
    const endedAt = new Date(clock.now + 100_000).toISOString();

    const ended = await h.callRepository.end(callId, 'accepted', 'completed', endedAt, { markRevoked: true });
    const again = await h.callRepository.end(callId, 'accepted', 'completed', endedAt, { markRevoked: true });

    expect(ended?.state).toBe('ended');
    expect(again).toBeNull();
    expect(await h.callRepository.getUsage(monthKey(clock.now))).toBe(100 * 187_500);
    expect((await callRow(h, callId)).turnRevokedAt).toBe(endedAt);
  });

  it('keeps the previous username for the sweeper when its revocation fails on reissue', async () => {
    const turn = fakeTurn();
    const { h, room, aliceClient, bobClient } = await setup({ turn });
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const first = waitForEvent(aliceClient, 'call:ice-servers-result');
    aliceClient.emit('call:ice-servers', { callId, protectIp: false });
    await first;

    turn.failRevoke = true;
    clock.now += 11_000;
    const second = waitForEvent(aliceClient, 'call:ice-servers-result');
    aliceClient.emit('call:ice-servers', { callId, protectIp: false });
    await second;
    expect((await callRow(h, callId)).turnUsername).toBe('turn-user-2,turn-user-1');

    turn.failRevoke = false;
    const ended = waitForEvent(bobClient, 'call:ended');
    aliceClient.emit('call:hangup', { callId });
    await ended;
    await settle(100);
    expect(turn.revoked.sort()).toEqual(['turn-user-1', 'turn-user-2']);
  });

  it('keeps a call alive through a 60 second network outage', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    bobClient.emit('call:heartbeat', { callId });
    aliceClient.emit('call:heartbeat', { callId });
    await settle(100);

    clock.now += 60_000;
    await h.callService.runMaintenance();
    expect((await callRow(h, callId)).state).not.toBe('ended');
  });

  it('lets the same user take over the call from a new socket once the old one went silent, even before the server notices the drop', async () => {
    const { h, alice, bob, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    aliceClient.emit('call:heartbeat', { callId });
    await settle(100);
    const reconnected = await h.connectAs(alice);

    const early = expectError(reconnected, 'call:heartbeat');
    reconnected.emit('call:heartbeat', { callId });
    expect((await early).code).toBe('call.notAllowed');

    clock.now += 76_000;
    reconnected.emit('call:heartbeat', { callId });
    await settle(100);
    const signal = waitForEvent<{ envelope: string }>(bobClient, 'call:signal');
    reconnected.emit('call:signal', { callId, to: bob.user.id, envelope: 'after-takeover' });
    expect((await signal).envelope).toBe('after-takeover');

    const stale = expectError(aliceClient, 'call:heartbeat');
    aliceClient.emit('call:heartbeat', { callId });
    expect((await stale).code).toBe('call.notAllowed');
  });

  it('never lets an idle device take over a live call through sync, even after the bound socket went quiet', async () => {
    const { h, alice, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const second = await h.connectAs(alice);
    clock.now += 30_000;

    const state = waitForEvent(second, 'call:state');
    second.emit('call:sync', {});
    await state;
    const refused = expectError(second, 'call:signal');
    second.emit('call:signal', { callId, to: (await callRow(h, callId)).calleeId, envelope: 'stolen' });
    expect((await refused).code).toBe('call.notAllowed');
  });

  it('counts signals from the bound socket as liveness so a heartbeat from another socket cannot take over', async () => {
    const { h, alice, bob, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const second = await h.connectAs(alice);
    clock.now += 25_000;
    const delivered = waitForEvent(bobClient, 'call:signal');
    aliceClient.emit('call:signal', { callId, to: bob.user.id, envelope: 'alive' });
    await delivered;

    const refused = expectError(second, 'call:heartbeat');
    second.emit('call:heartbeat', { callId });
    expect((await refused).code).toBe('call.notAllowed');
  });

  it('ignores an automatic hangup from a device that does not hold the live call, but honours a forced one', async () => {
    const { h, alice, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const second = await h.connectAs(alice);

    const refused = expectError(second, 'call:hangup');
    second.emit('call:hangup', { callId });
    expect((await refused).code).toBe('call.notAllowed');
    expect((await callRow(h, callId)).state).not.toBe('ended');

    const ended = waitForEvent(bobClient, 'call:ended');
    second.emit('call:hangup', { callId, force: true });
    await ended;
    expect((await callRow(h, callId)).state).toBe('ended');
  });

  it('lets the device that dropped a call hang it up from a new socket once the old binding went quiet', async () => {
    const { h, alice, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const reconnected = await h.connectAs(alice);
    clock.now += 76_000;

    const ended = waitForEvent(bobClient, 'call:ended');
    reconnected.emit('call:hangup', { callId });
    await ended;
    expect((await callRow(h, callId)).state).toBe('ended');
  });

  it('keeps the binding of a backgrounded device whose throttled heartbeats arrive once a minute', async () => {
    const { h, alice, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    aliceClient.emit('call:heartbeat', { callId });
    await settle(100);
    const other = await h.connectAs(alice);

    for (let minute = 0; minute < 3; minute += 1) {
      clock.now += 59_000;
      await h.callService.runMaintenance();

      const takeover = expectError(other, 'call:heartbeat');
      other.emit('call:heartbeat', { callId });
      expect((await takeover).code).toBe('call.notAllowed');
      const hangup = expectError(other, 'call:hangup');
      other.emit('call:hangup', { callId });
      expect((await hangup).code).toBe('call.notAllowed');

      clock.now += 1_000;
      bobClient.emit('call:heartbeat', { callId });
      aliceClient.emit('call:heartbeat', { callId });
      await settle(50);
    }
    expect((await callRow(h, callId)).state).not.toBe('ended');
  });

  it('never gives another account or an unbound device the call while the peer is away', async () => {
    const { h, alice, bob, carol, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    bobClient.emit('call:heartbeat', { callId });
    await settle(100);
    bobClient.disconnect();
    await settle(100);
    clock.now += 60_000;

    const carolClient = await h.connectAs(carol);
    const carolState = waitForEvent<unknown>(carolClient, 'call:state');
    carolClient.emit('call:sync', { callId });
    expect(await carolState).toBeNull();
    for (const event of ['call:heartbeat', 'call:hangup'] as const) {
      const refused = expectError(carolClient, event);
      carolClient.emit(event, { callId });
      expect((await refused).code).toBe('call.notAllowed');
    }
    const carolSignal = expectError(carolClient, 'call:signal');
    carolClient.emit('call:signal', { callId, to: alice.user.id, envelope: 'intruder' });
    expect((await carolSignal).code).toBe('call.notAllowed');

    const idle = await h.connectAs(alice);
    const idleState = waitForEvent<{ peerLive: boolean; transferable: boolean }>(idle, 'call:state');
    idle.emit('call:sync', { callId: null });
    expect(await idleState).toMatchObject({ peerLive: true, transferable: false });
    const takeover = expectError(idle, 'call:heartbeat');
    idle.emit('call:heartbeat', { callId });
    expect((await takeover).code).toBe('call.notAllowed');
    const stolen = expectError(idle, 'call:signal');
    idle.emit('call:signal', { callId, to: bob.user.id, envelope: 'stolen' });
    expect((await stolen).code).toBe('call.notAllowed');
    expect((await callRow(h, callId)).state).not.toBe('ended');
  });

  it('tells the other participant that a backgrounded peer can still come back for three minutes', async () => {
    const { h, alice, bob, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    bobClient.emit('call:heartbeat', { callId });
    await settle(100);

    const connected = waitForEvent<{ callId: string; peerLive: boolean }>(aliceClient, 'call:state');
    aliceClient.emit('call:sync', { callId });
    expect(await connected).toMatchObject({ callId, peerLive: true });

    bobClient.disconnect();
    await settle(100);
    clock.now += 150_000;
    await h.callService.runMaintenance();
    const away = waitForEvent<{ peerLive: boolean }>(aliceClient, 'call:state');
    aliceClient.emit('call:sync', { callId });
    expect((await away).peerLive).toBe(true);
    expect((await callRow(h, callId)).state).not.toBe('ended');

    clock.now += 31_000;
    const gone = waitForEvent<{ peerLive: boolean }>(aliceClient, 'call:state');
    aliceClient.emit('call:sync', { callId });
    expect((await gone).peerLive).toBe(false);

    const back = await h.connectAs(bob);
    const resumed = waitForEvent<{ callId: string; peerLive: boolean }>(back, 'call:state');
    back.emit('call:sync', { callId });
    expect(await resumed).toMatchObject({ callId, peerLive: true });
    const signal = waitForEvent<{ envelope: string }>(aliceClient, 'call:signal');
    back.emit('call:signal', { callId, to: alice.user.id, envelope: 'resumed' });
    expect((await signal).envelope).toBe('resumed');
    const refreshed = waitForEvent<{ peerLive: boolean }>(aliceClient, 'call:state');
    aliceClient.emit('call:sync', { callId });
    expect((await refreshed).peerLive).toBe(true);
  });

  it('does not bind a socket that says it is not in the call, so a dropped call is not offered back as another device', async () => {
    const { h, alice, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    aliceClient.disconnect();
    await settle(100);
    const reopened = await h.connectAs(alice);

    const state = waitForEvent<{ callId: string; transferable: boolean }>(reopened, 'call:state');
    reopened.emit('call:sync', { callId: null });
    expect(await state).toMatchObject({ callId, transferable: true });
    const refused = expectError(reopened, 'call:signal');
    reopened.emit('call:signal', { callId, to: (await callRow(h, callId)).calleeId, envelope: 'not-in-call' });
    expect((await refused).code).toBe('call.notAllowed');
  });

  it('rebinds a reconnecting device that reports the call it is still in', async () => {
    const { h, alice, bob, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    aliceClient.disconnect();
    await settle(100);
    const reconnected = await h.connectAs(alice);

    const state = waitForEvent<{ transferable: boolean }>(reconnected, 'call:state');
    reconnected.emit('call:sync', { callId });
    expect((await state).transferable).toBe(false);
    const signal = waitForEvent<{ envelope: string }>(bobClient, 'call:signal');
    reconnected.emit('call:signal', { callId, to: bob.user.id, envelope: 'still-here' });
    expect((await signal).envelope).toBe('still-here');
  });

  it('only offers a transfer while the other person is still in the call', async () => {
    const { h, alice, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const second = await h.connectAs(alice);

    const live = waitForEvent<{ transferable: boolean }>(second, 'call:state');
    second.emit('call:sync', { callId: null });
    expect((await live).transferable).toBe(true);

    clock.now += 31_000;
    const silent = waitForEvent<{ transferable: boolean }>(second, 'call:state');
    second.emit('call:sync', { callId: null });
    expect((await silent).transferable).toBe(false);

    await beat(bobClient, callId, true);
    const back = waitForEvent<{ transferable: boolean }>(second, 'call:state');
    second.emit('call:sync', { callId: null });
    expect((await back).transferable).toBe(true);

    bobClient.disconnect();
    await settle(100);
    const gone = waitForEvent<{ transferable: boolean }>(second, 'call:state');
    second.emit('call:sync', { callId: null });
    expect((await gone).transferable).toBe(false);
  });

  it('still lets the bound device hang up a live call without forcing', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const ended = waitForEvent(bobClient, 'call:ended');
    aliceClient.emit('call:hangup', { callId });
    await ended;
  });

  it('only lets the bound devices signal and heartbeat, and keeps another device from taking over via sync', async () => {
    const { h, alice, bob, room, aliceClient, bobClient } = await setup();
    const bobTablet = await h.connectAs(bob);
    const aliceSecond = await h.connectAs(alice);
    const callId = await ring(h, aliceClient, [bobClient, bobTablet], room.id);
    await answer(aliceClient, bobClient, callId);

    for (const intruder of [bobTablet, aliceSecond]) {
      const heartbeat = expectError(intruder, 'call:heartbeat');
      intruder.emit('call:heartbeat', { callId });
      expect((await heartbeat).code).toBe('call.notAllowed');
      const state = waitForEvent<{ role: string }>(intruder, 'call:state');
      intruder.emit('call:sync', {});
      expect(await state).toMatchObject({ callId });
    }

    const signal = waitForEvent(bobClient, 'call:signal');
    aliceClient.emit('call:signal', { callId, to: bob.user.id, envelope: 'offer' });
    await signal;
    const stolen = expectError(aliceSecond, 'call:signal');
    aliceSecond.emit('call:signal', { callId, to: bob.user.id, envelope: 'evil' });
    expect((await stolen).code).toBe('call.notAllowed');

    const tabletSignals = collectEvents(bobTablet, 'call:signal');
    aliceClient.emit('call:signal', { callId, to: bob.user.id, envelope: 'again' });
    await waitForEvent(bobClient, 'call:signal', (payload: { envelope: string }) => payload.envelope === 'again');
    expect(tabletSignals).toHaveLength(0);
  });

  it('queues signals briefly for an unbound peer instead of broadcasting them, then flushes on sync', async () => {
    const { h, alice, bob, room, aliceClient, bobClient } = await setup();
    const bobTablet = await h.connectAs(bob);
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    bobClient.disconnect();
    await settle(100);

    const tabletSignals = collectEvents(bobTablet, 'call:signal');
    aliceClient.emit('call:signal', { callId, to: bob.user.id, envelope: 'queued' });
    await settle(200);
    expect(tabletSignals).toHaveLength(0);

    const flushed = waitForEvent<{ envelope: string }>(bobTablet, 'call:signal');
    bobTablet.emit('call:sync', {});
    expect((await flushed).envelope).toBe('queued');
    void alice;
  });

  it('does not announce declined-elsewhere when the decline did not end the call', async () => {
    const { h, bob, room, aliceClient, bobClient } = await setup();
    const bobTablet = await h.connectAs(bob);
    const callId = await ring(h, aliceClient, [bobClient, bobTablet], room.id);
    await answer(aliceClient, bobClient, callId);
    const elsewhere = collectEvents(bobTablet, 'call:declined-elsewhere');
    const error = expectError(bobClient, 'call:decline');
    bobClient.emit('call:decline', { callId });
    expect((await error).code).toBe('call.invalidState');
    await settle(100);
    expect(elsewhere).toHaveLength(0);
  });

  it('rejects envelopes over the schema limit as too large', async () => {
    const { aliceClient } = await setup();
    const big = expectError(aliceClient, 'call:signal');
    aliceClient.emit('call:signal', { callId: newCallId(), to: 'x', envelope: 'x'.repeat(16 * 1024 + 1) });
    expect((await big).code).toBe('call.signalTooLarge');
  });
});

describe('call transfer between devices', () => {
  it('keeps the old device until the peer accepts, then moves the live call without ending it', async () => {
    const { h, alice, bob, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const alicePhone = await h.connectAs(alice);
    const endedEvents = [...collectEvents(aliceClient, 'call:ended'), ...collectEvents(bobClient, 'call:ended')];
    const earlyTransferred = collectEvents(aliceClient, 'call:transferred');

    const peerTransfer = waitForEvent<{ callId: string; from: string; envelope: string }>(bobClient, 'call:peer-transfer');
    alicePhone.emit('call:transfer', { callId, envelope: 'transfer-envelope' });
    expect(await peerTransfer).toEqual({ callId, from: alice.user.id, envelope: 'transfer-envelope' });
    await settle(100);
    expect(earlyTransferred).toHaveLength(0);
    const stillOld = waitForEvent<{ envelope: string }>(bobClient, 'call:signal');
    aliceClient.emit('call:signal', { callId, to: bob.user.id, envelope: 'old-still-bound' });
    expect((await stillOld).envelope).toBe('old-still-bound');

    const transferred = waitForEvent<{ callId: string }>(aliceClient, 'call:transferred');
    const accepted = waitForEvent<{ callId: string; envelope: string }>(alicePhone, 'call:transfer-accepted');
    bobClient.emit('call:transfer-accept', { callId, envelope: 'transfer-accept-envelope' });
    expect(await accepted).toEqual({ callId, envelope: 'transfer-accept-envelope' });
    expect(await transferred).toEqual({ callId });

    const signal = waitForEvent<{ envelope: string }>(bobClient, 'call:signal');
    alicePhone.emit('call:signal', { callId, to: bob.user.id, envelope: 'from-phone' });
    expect((await signal).envelope).toBe('from-phone');
    const stale = expectError(aliceClient, 'call:signal');
    aliceClient.emit('call:signal', { callId, to: bob.user.id, envelope: 'late' });
    expect((await stale).code).toBe('call.notAllowed');
    await settle(100);
    expect((await callRow(h, callId)).state).not.toBe('ended');
    expect(endedEvents).toHaveLength(0);
    expect(await systemEventTypes(h, room.id)).toEqual([]);
  });

  it('tells the other devices of the same account whether the bound device has its microphone muted and camera on, so a transfer keeps them', async () => {
    const { h, alice, bob, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const alicePhone = await h.connectAs(alice);
    const bobTablet = await h.connectAs(bob);

    const before = waitForEvent<Record<string, unknown>>(alicePhone, 'call:state');
    alicePhone.emit('call:sync', { callId: null });
    expect(await before).not.toHaveProperty('media');

    aliceClient.emit('call:heartbeat', { callId, media: { muted: true, camera: true } });
    await settle(100);
    const reported = waitForEvent<{ media?: unknown }>(alicePhone, 'call:state');
    alicePhone.emit('call:sync', { callId: null });
    expect((await reported).media).toEqual({ muted: true, camera: true });

    const peerView = waitForEvent<Record<string, unknown>>(bobTablet, 'call:state');
    bobTablet.emit('call:sync', { callId: null });
    expect(await peerView).not.toHaveProperty('media');

    aliceClient.emit('call:heartbeat', { callId, media: { muted: false, camera: false } });
    await settle(100);
    const updated = waitForEvent<{ media?: unknown }>(alicePhone, 'call:state');
    alicePhone.emit('call:sync', { callId: null });
    expect((await updated).media).toEqual({ muted: false, camera: false });

    const intruder = expectError(alicePhone, 'call:heartbeat');
    alicePhone.emit('call:heartbeat', { callId, media: { muted: true, camera: true } });
    expect((await intruder).code).toBe('call.notAllowed');
    const unchanged = waitForEvent<{ media?: unknown }>(alicePhone, 'call:state');
    alicePhone.emit('call:sync', { callId: null });
    expect((await unchanged).media).toEqual({ muted: false, camera: false });

    const invalid = expectError(aliceClient, 'call:heartbeat');
    aliceClient.emit('call:heartbeat', { callId, media: { muted: 'yes', camera: true } });
    expect((await invalid).code).toBe('validation.invalidPayload');
  });

  it('pushes a media change to the other devices of the account right away, but not to the bound device or the other participant', async () => {
    const { h, alice, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const alicePhone = await h.connectAs(alice);
    const selfEcho = collectEvents(aliceClient, 'call:state');
    const peerEcho = collectEvents(bobClient, 'call:state');

    const first = waitForEvent<{ callId: string; media?: unknown; transferable: boolean }>(alicePhone, 'call:state');
    aliceClient.emit('call:heartbeat', { callId, media: { muted: false, camera: false } });
    expect(await first).toMatchObject({ callId, transferable: true, media: { muted: false, camera: false } });

    const changed = waitForEvent<{ media?: unknown }>(alicePhone, 'call:state');
    aliceClient.emit('call:heartbeat', { callId, media: { muted: true, camera: false } });
    expect((await changed).media).toEqual({ muted: true, camera: false });

    const repeats = collectEvents(alicePhone, 'call:state');
    aliceClient.emit('call:heartbeat', { callId, media: { muted: true, camera: false } });
    await settle(100);
    expect(repeats).toHaveLength(0);
    expect(selfEcho).toHaveLength(0);
    expect(peerEcho).toHaveLength(0);
  });

  it('forgets the reported media state when the call ends', async () => {
    const { h, alice, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    aliceClient.emit('call:heartbeat', { callId, media: { muted: true, camera: true } });
    await settle(100);
    const ended = waitForEvent(bobClient, 'call:ended');
    aliceClient.emit('call:hangup', { callId });
    await ended;

    const nextCall = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, nextCall);
    const alicePhone = await h.connectAs(alice);
    const state = waitForEvent<Record<string, unknown>>(alicePhone, 'call:state');
    alicePhone.emit('call:sync', { callId: null });
    const payload = await state;
    expect(payload).toMatchObject({ callId: nextCall });
    expect(payload).not.toHaveProperty('media');
  });

  it('forgets the media state of the device that moved away, so the new device reports its own', async () => {
    const { h, alice, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    aliceClient.emit('call:heartbeat', { callId, media: { muted: true, camera: true } });
    await settle(100);
    const alicePhone = await h.connectAs(alice);
    const moved = waitForEvent(bobClient, 'call:peer-transfer');
    alicePhone.emit('call:transfer', { callId, envelope: 'transfer-envelope' });
    await moved;
    const accepted = waitForEvent(alicePhone, 'call:transfer-accepted');
    bobClient.emit('call:transfer-accept', { callId, envelope: 'transfer-accept-envelope' });
    await accepted;

    const state = waitForEvent<Record<string, unknown>>(aliceClient, 'call:state');
    aliceClient.emit('call:sync', { callId: null });
    const payload = await state;
    expect(payload).toMatchObject({ callId, transferable: true });
    expect(payload).not.toHaveProperty('media');
  });

  it('refuses a second transfer while one is pending and drops an unanswered one after 15 seconds', async () => {
    const { h, alice, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const phone = await h.connectAs(alice);
    const tablet = await h.connectAs(alice);
    const moved = waitForEvent(bobClient, 'call:peer-transfer');
    phone.emit('call:transfer', { callId, envelope: 'e' });
    await moved;

    const busy = expectError(tablet, 'call:transfer');
    tablet.emit('call:transfer', { callId, envelope: 'e' });
    expect((await busy).code).toBe('call.invalidState');

    const failed = waitForEvent<{ callId: string }>(phone, 'call:transfer-failed');
    clock.now += 15_000;
    await h.callService.runMaintenance();
    expect(await failed).toEqual({ callId });
    const lateAccept = expectError(bobClient, 'call:transfer-accept');
    bobClient.emit('call:transfer-accept', { callId, envelope: 'late' });
    expect((await lateAccept).code).toBe('call.invalidState');

    const again = waitForEvent(bobClient, 'call:peer-transfer');
    tablet.emit('call:transfer', { callId, envelope: 'e' });
    await again;
    expect((await callRow(h, callId)).state).not.toBe('ended');
  });

  it('ignores an accept when the pending device left or when the accept comes from the transferring side', async () => {
    const { h, alice, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const phone = await h.connectAs(alice);
    const moved = waitForEvent(bobClient, 'call:peer-transfer');
    phone.emit('call:transfer', { callId, envelope: 'e' });
    await moved;

    const own = expectError(aliceClient, 'call:transfer-accept');
    aliceClient.emit('call:transfer-accept', { callId, envelope: 'self' });
    expect((await own).code).toBe('call.invalidState');

    const earlyTransferred = collectEvents(aliceClient, 'call:transferred');
    phone.disconnect();
    await settle(100);
    const lateAccept = expectError(bobClient, 'call:transfer-accept');
    bobClient.emit('call:transfer-accept', { callId, envelope: 'late' });
    expect((await lateAccept).code).toBe('call.invalidState');
    await settle(100);
    expect(earlyTransferred).toHaveLength(0);

    const stillBound = waitForEvent<{ envelope: string }>(bobClient, 'call:signal');
    aliceClient.emit('call:signal', { callId, to: (await callRow(h, callId)).calleeId, envelope: 'still-old' });
    expect((await stillBound).envelope).toBe('still-old');
  });

  it('works for the callee role, keeps the timer and lets the new device fetch ICE servers right away', async () => {
    const turn = fakeTurn();
    const { h, alice, bob, room, aliceClient, bobClient } = await setup({ turn });
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const firstIce = waitForEvent(bobClient, 'call:ice-servers-result');
    bobClient.emit('call:ice-servers', { callId, protectIp: false });
    await firstIce;
    const bobLaptop = await h.connectAs(bob);
    const state = waitForEvent<{ answeredAt: string | null; role: string }>(bobLaptop, 'call:state');
    bobLaptop.emit('call:sync', {});
    expect(await state).toMatchObject({ role: 'callee', answeredAt: (await callRow(h, callId)).answeredAt });

    const peerTransfer = waitForEvent<{ from: string }>(aliceClient, 'call:peer-transfer');
    bobLaptop.emit('call:transfer', { callId, envelope: 'e' });
    expect((await peerTransfer).from).toBe(bob.user.id);
    const transferred = waitForEvent(bobClient, 'call:transferred');
    aliceClient.emit('call:transfer-accept', { callId, envelope: 'a' });
    await transferred;
    await settle(100);
    expect(turn.revoked).toContain('turn-user-1');

    const ice = waitForEvent<{ iceServers: unknown[] }>(bobLaptop, 'call:ice-servers-result');
    bobLaptop.emit('call:ice-servers', { callId, protectIp: false });
    expect((await ice).iceServers.length).toBeGreaterThan(0);
    expect(alice.user.id).not.toBe(bob.user.id);
  });

  it('refuses transfers from other users, from the bound device, for ringing calls and beyond the rate limit', async () => {
    const { h, alice, carol, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    const alicePhone = await h.connectAs(alice);
    const ringing = expectError(alicePhone, 'call:transfer');
    alicePhone.emit('call:transfer', { callId, envelope: 'e' });
    expect((await ringing).code).toBe('call.invalidState');

    await answer(aliceClient, bobClient, callId);
    const carolClient = await h.connectAs(carol);
    const stranger = expectError(carolClient, 'call:transfer');
    carolClient.emit('call:transfer', { callId, envelope: 'e' });
    expect((await stranger).code).toBe('call.notAllowed');

    const self = expectError(aliceClient, 'call:transfer');
    aliceClient.emit('call:transfer', { callId, envelope: 'e' });
    expect((await self).code).toBe('call.invalidState');

    const devices = [alicePhone, await h.connectAs(alice), await h.connectAs(alice), await h.connectAs(alice)];
    for (const device of devices.slice(0, 3)) {
      const moved = waitForEvent(bobClient, 'call:peer-transfer');
      device.emit('call:transfer', { callId, envelope: 'e' });
      await moved;
      const accepted = waitForEvent(device, 'call:transfer-accepted');
      bobClient.emit('call:transfer-accept', { callId, envelope: 'a' });
      await accepted;
    }
    const limited = expectError(devices[3]!, 'call:transfer');
    devices[3]!.emit('call:transfer', { callId, envelope: 'e' });
    expect((await limited).code).toBe('call.rateLimited');
  });

  it('only lets the bound peer device answer a transfer', async () => {
    const { h, alice, bob, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const alicePhone = await h.connectAs(alice);
    const bobTablet = await h.connectAs(bob);
    const moved = waitForEvent(bobClient, 'call:peer-transfer');
    alicePhone.emit('call:transfer', { callId, envelope: 'e' });
    await moved;
    const refused = expectError(bobTablet, 'call:transfer-accept');
    bobTablet.emit('call:transfer-accept', { callId, envelope: 'forged' });
    expect((await refused).code).toBe('call.notAllowed');
  });
});
