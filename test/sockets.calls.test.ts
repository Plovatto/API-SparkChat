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
  generated: number;
  revoked: string[];
  generateSpy: ReturnType<typeof vi.fn<(ttlSeconds: number) => void>>;
}

function fakeTurn(): FakeTurn {
  const turn: FakeTurn = {
    failGenerate: false,
    failRevoke: false,
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
    revoke(username: string): Promise<void> {
      if (turn.failRevoke) {
        return Promise.reject(new Error('cloudflare down'));
      }
      turn.revoked.push(username);
      return Promise.resolve();
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

    expect(turn.generateSpy).toHaveBeenCalledWith(14_400);
    expect(issued).toEqual({
      callId,
      iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478'], username: 'turn-user-1', credential: 'secret-1' }],
      expiresAt: new Date(clock.now + 14_400_000).toISOString(),
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

  it('ends calls whose heartbeat stopped at the last heartbeat time and keeps beating calls alive', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);

    clock.now += 70_000;
    aliceClient.emit('call:heartbeat', { callId });
    await settle(100);
    const lastBeat = new Date(clock.now).toISOString();

    clock.now += 40_000;
    await h.callService.runMaintenance();
    expect((await callRow(h, callId)).state).toBe('accepted');

    const ended = waitForEvent<CallEndedEvent>(bobClient, 'call:ended');
    clock.now += 6000;
    await h.callService.runMaintenance();
    const event = await ended;

    expect(event.reason).toBe('connection-lost');
    expect(event.endedAt).toBe(lastBeat);
    expect(await systemEventTypes(h, room.id)).toEqual(['call.ended']);
  });

  it('keeps the call when the last socket drops until the heartbeat expires', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);

    aliceClient.disconnect();
    await settle(200);
    expect((await callRow(h, callId)).state).toBe('accepted');

    clock.now += 120_000;
    await h.callService.runMaintenance();
    expect((await callRow(h, callId)).endReason).toBe('connection-lost');
  });

  it('completes calls at the four hour limit', async () => {
    const { h, room, aliceClient, bobClient } = await setup();
    const callId = await ring(h, aliceClient, [bobClient], room.id);
    await answer(aliceClient, bobClient, callId);
    const answeredAt = clock.now;

    clock.now = answeredAt + 4 * 3_600_000 - 1000;
    await h.callRepository.touchHeartbeat(callId, new Date(clock.now).toISOString());
    await h.callService.runMaintenance();
    expect((await callRow(h, callId)).state).toBe('accepted');

    clock.now = answeredAt + 4 * 3_600_000 + 1000;
    await h.callRepository.touchHeartbeat(callId, new Date(clock.now).toISOString());
    const ended = waitForEvent<CallEndedEvent>(aliceClient, 'call:ended');
    await h.callService.runMaintenance();

    const event = await ended;
    expect(event.reason).toBe('completed');
    expect(event.endedAt).toBe(new Date(answeredAt + 4 * 3_600_000).toISOString());
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
    expect(await state).toEqual({ callId, state: 'accepted', roomId: room.id, kind: 'video', peerId: bob.user.id, role: 'caller' });

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

    clock.now += 50_000;
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
  it('caps the worst-case estimate at two credentials per call however often they are reissued', async () => {
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
    expect(await h.callRepository.getUsage(monthKey(clock.now))).toBe(1_350_000_000);
  });

  it('serves STUN only to a user who used more than twenty relayed hours this month', async () => {
    const turn = fakeTurn();
    const { h, alice, bob, room, aliceClient, bobClient } = await setup({ turn });
    const earlier = new Date(clock.now - 3_600_000 * 25).toISOString();
    const earlierEnd = new Date(clock.now - 3_600_000 * 4).toISOString();
    await h.callRepository.insertEnded({ id: newCallId(), roomId: room.id, callerId: alice.user.id, calleeId: bob.user.id, kind: 'voice', createdAt: earlier }, 'completed');
    await h.db.run(
      sql`UPDATE calls SET answered_at = ${earlier}, ended_at = ${earlierEnd}, turn_username = 'old', relay_used = 1 WHERE state = 'ended'`,
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
    await h.callRepository.recordTurnIssued(callId, 'caller', 'u1');
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
