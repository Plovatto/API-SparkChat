import { logger } from '../../config/logger.js';
import { AppError } from '../../lib/app-error.js';
import type { AppServer } from '../../sockets/events.js';
import { emitToUser, joinUserSocketsToRoom, listUserSockets, userRoom } from '../../sockets/user-sockets.js';
import { INITIAL_MESSAGES_LIMIT, systemEvent, type MessageService } from '../messages/index.js';
import type { RoomRecord, RoomService } from '../rooms/index.js';
import { ASSISTANT_USER_ID } from '../users/index.js';
import { estimateRelayBytes, monthKey, type CallBudget } from './call-budget.js';
import type { CallStatePayload } from './call.events.js';
import type { CallRateLimiter } from './call.rate-limiter.js';
import type { CallRepository } from './call.repository.js';
import { transition, type CallEvent } from './call.state.js';
import {
  HEARTBEAT_TIMEOUT_MS,
  MAX_CALL_DURATION_MS,
  MAX_ENVELOPE_LENGTH,
  RESTART_GRACE_MS,
  RING_TIMEOUT_MS,
  TURN_TTL_SECONDS,
  type CallDegrade,
  type CallKind,
  type CallRecord,
  type CallRole,
  type IceServer,
} from './call.types.js';
import { STUN_ONLY_SERVERS, type TurnProvider } from './turn-credentials.js';

const SWEEP_INTERVAL_MS = 2000;
const REVOKE_SWEEP_BATCH = 50;

export interface CallActor {
  userId: string;
  socketId: string;
}

export interface CallServiceOptions {
  enabled?: boolean;
  now?: () => number;
}

export interface IceServersResult {
  callId: string;
  iceServers: IceServer[];
  expiresAt: string;
  relayOnly: boolean;
  degrade: CallDegrade;
}

export interface CallConfig {
  enabled: boolean;
  relayAvailable: boolean;
  degrade: CallDegrade;
}

interface SocketBindings {
  caller?: string;
  callee?: string;
}

function roleOf(call: CallRecord, userId: string): CallRole | null {
  if (call.callerId === userId) {
    return 'caller';
  }
  return call.calleeId === userId ? 'callee' : null;
}

function peerOf(call: CallRecord, role: CallRole): string {
  return role === 'caller' ? call.calleeId : call.callerId;
}

export class CallService {
  private readonly bindings = new Map<string, SocketBindings>();
  private readonly now: () => number;
  private readonly enabled: boolean;
  private readonly graceUntil: number;

  constructor(
    private readonly io: AppServer,
    private readonly repository: CallRepository,
    private readonly roomService: RoomService,
    private readonly messageService: MessageService,
    private readonly budget: CallBudget,
    private readonly limiter: CallRateLimiter,
    private readonly turnProvider: TurnProvider | null,
    options: CallServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.enabled = options.enabled ?? true;
    this.graceUntil = this.now() + RESTART_GRACE_MS;
  }

  async getConfig(): Promise<CallConfig> {
    if (!this.enabled) {
      return { enabled: false, relayAvailable: false, degrade: 'none' };
    }
    const snapshot = await this.budget.snapshot();
    return { enabled: true, relayAvailable: this.turnProvider !== null && snapshot.relayAvailable, degrade: snapshot.degrade };
  }

  startMaintenance(): () => void {
    const timer = setInterval(() => {
      this.runMaintenance().catch((err: unknown) => {
        logger.error({ err }, 'Call maintenance failed');
      });
    }, SWEEP_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  async runMaintenance(): Promise<void> {
    await this.sweepOpenCalls();
    await this.sweepCredentials();
  }

  async start(actor: CallActor, input: { callId: string; roomId: string; kind: CallKind; envelope: string }): Promise<void> {
    this.requireEnabled();
    assertEnvelopeSize(input.envelope);

    const room = await this.roomService.getRoomById(input.roomId);
    const calleeId = room ? this.resolveCallee(room, actor.userId) : null;
    if (!calleeId) {
      throw AppError.of('call.notAllowed');
    }

    if (!this.limiter.tryStart(actor.userId, calleeId)) {
      throw AppError.of('call.rateLimited');
    }

    if (await this.repository.findById(input.callId)) {
      throw AppError.of('call.invalidState');
    }

    await this.sweepOpenCalls();

    const createdAtMs = this.now();
    const newCall = {
      id: input.callId,
      roomId: input.roomId,
      callerId: actor.userId,
      calleeId,
      kind: input.kind,
      createdAt: new Date(createdAtMs).toISOString(),
    };

    if (await this.repository.findOpenForUser(actor.userId)) {
      throw AppError.of('call.alreadyInCall');
    }

    if (await this.repository.findOpenForUser(calleeId)) {
      await this.rejectBusy(newCall);
      throw AppError.of('call.peerBusy');
    }

    if (!(await this.repository.insertIfBothFree(newCall))) {
      if (await this.repository.findOpenForUser(actor.userId)) {
        throw AppError.of('call.alreadyInCall');
      }
      await this.rejectBusy(newCall);
      throw AppError.of('call.peerBusy');
    }

    this.bindings.set(input.callId, { caller: actor.socketId });
    this.io.to(userRoom(calleeId)).emit('call:incoming', {
      callId: input.callId,
      roomId: input.roomId,
      kind: input.kind,
      callerId: actor.userId,
      envelope: input.envelope,
      ringExpiresAt: new Date(createdAtMs + RING_TIMEOUT_MS).toISOString(),
    });
  }

  async accept(actor: CallActor, input: { callId: string; envelope: string }): Promise<void> {
    this.requireEnabled();
    assertEnvelopeSize(input.envelope);

    const call = await this.requireParticipant(input.callId, actor.userId, 'callee');
    if (call.state === 'ringing' && this.now() - Date.parse(call.createdAt) >= RING_TIMEOUT_MS) {
      await this.finish(call.id, { type: 'ring-timeout' });
      throw AppError.of('call.invalidState');
    }

    const accepted = await this.repository.accept(
      call.id,
      actor.userId,
      actor.socketId,
      new Date(this.now()).toISOString(),
      new Date(this.now() - RING_TIMEOUT_MS).toISOString(),
    );

    if (!accepted) {
      const current = await this.repository.findById(call.id);
      if (current && (current.state === 'accepted' || current.state === 'active')) {
        return;
      }
      throw AppError.of('call.invalidState');
    }

    const bindings = this.bindings.get(call.id) ?? {};
    bindings.callee = actor.socketId;
    this.bindings.set(call.id, bindings);

    this.io.to(userRoom(call.callerId)).emit('call:accepted', { callId: call.id, envelope: input.envelope, deviceId: actor.socketId });
    this.io.to(actor.socketId).emit('call:accepted', { callId: call.id, envelope: input.envelope, deviceId: actor.socketId });
    this.io.in(userRoom(call.calleeId)).except(actor.socketId).emit('call:answered-elsewhere', { callId: call.id });
  }

  async decline(actor: CallActor, callId: string): Promise<void> {
    this.requireEnabled();
    const call = await this.requireParticipant(callId, actor.userId, 'callee');
    if (call.state !== 'ringing') {
      throw AppError.of('call.invalidState');
    }
    this.io.in(userRoom(call.calleeId)).except(actor.socketId).emit('call:declined-elsewhere', { callId });
    await this.finish(callId, { type: 'decline' });
  }

  async hangup(actor: CallActor, callId: string): Promise<void> {
    this.requireEnabled();
    const call = await this.requireParticipant(callId, actor.userId);
    if (call.state === 'ended') {
      return;
    }
    const role = roleOf(call, actor.userId);
    if (role === 'callee' && call.state === 'ringing') {
      this.io.in(userRoom(call.calleeId)).except(actor.socketId).emit('call:declined-elsewhere', { callId });
    }
    await this.finish(callId, { type: 'hangup', by: role ?? 'caller' });
  }

  async silence(actor: CallActor, callId: string): Promise<void> {
    this.requireEnabled();
    await this.requireParticipant(callId, actor.userId, 'callee');
  }

  async signal(actor: CallActor, input: { callId: string; to: string; envelope: string }): Promise<void> {
    this.requireEnabled();
    assertEnvelopeSize(input.envelope);

    const call = await this.requireParticipant(input.callId, actor.userId);
    const role = roleOf(call, actor.userId);
    if (!role || peerOf(call, role) !== input.to) {
      throw AppError.of('call.notAllowed');
    }
    if (call.state !== 'accepted' && call.state !== 'active') {
      throw AppError.of('call.invalidState');
    }
    if (!this.limiter.trySignal(call.id)) {
      throw AppError.of('call.rateLimited');
    }

    const bindings = this.bindings.get(call.id) ?? {};
    const bound = bindings[role];
    if (bound !== undefined && bound !== actor.socketId && this.io.sockets.sockets.has(bound)) {
      throw AppError.of('call.notAllowed');
    }
    bindings[role] = actor.socketId;
    this.bindings.set(call.id, bindings);

    if (role === 'callee' && call.state === 'accepted') {
      await this.repository.markActive(call.id);
    }

    const peerRole: CallRole = role === 'caller' ? 'callee' : 'caller';
    const peerSocket = bindings[peerRole];
    const target = peerSocket !== undefined && this.io.sockets.sockets.has(peerSocket) ? peerSocket : userRoom(input.to);
    this.io.to(target).emit('call:signal', { callId: call.id, from: actor.userId, envelope: input.envelope });
  }

  async heartbeat(actor: CallActor, callId: string): Promise<void> {
    this.requireEnabled();
    const call = await this.requireParticipant(callId, actor.userId);
    if (call.state === 'accepted' || call.state === 'active') {
      await this.repository.touchHeartbeat(callId, new Date(this.now()).toISOString());
    }
  }

  async sync(actor: CallActor): Promise<void> {
    this.requireEnabled();
    const call = await this.repository.findOpenForUser(actor.userId);
    const role = call ? roleOf(call, actor.userId) : null;
    if (!call || !role || call.state === 'ended') {
      this.io.to(actor.socketId).emit('call:state', null);
      return;
    }

    if (call.state === 'accepted' || call.state === 'active') {
      const bindings = this.bindings.get(call.id) ?? {};
      bindings[role] = actor.socketId;
      this.bindings.set(call.id, bindings);
      if (role === 'callee') {
        await this.repository.rebindAcceptedDevice(call.id, actor.socketId);
      }
      await this.repository.touchHeartbeat(call.id, new Date(this.now()).toISOString());
    }

    const payload: CallStatePayload = {
      callId: call.id,
      state: call.state,
      roomId: call.roomId,
      kind: call.kind,
      peerId: peerOf(call, role),
      role,
    };
    this.io.to(actor.socketId).emit('call:state', payload);
  }

  async iceServers(actor: CallActor, input: { callId: string; protectIp: boolean }): Promise<IceServersResult> {
    this.requireEnabled();
    const call = await this.requireParticipant(input.callId, actor.userId);
    const role = roleOf(call, actor.userId);
    if (!role) {
      throw AppError.of('call.notAllowed');
    }
    if (call.state !== 'accepted' && call.state !== 'active') {
      throw AppError.of('call.invalidState');
    }
    if (!this.limiter.tryIceServers(call.id, actor.userId)) {
      throw AppError.of('call.rateLimited');
    }

    const snapshot = await this.budget.snapshot();
    const expiresAt = new Date(this.now() + TURN_TTL_SECONDS * 1000).toISOString();
    const stunOnly = (): IceServersResult => ({
      callId: call.id,
      iceServers: STUN_ONLY_SERVERS,
      expiresAt,
      relayOnly: false,
      degrade: snapshot.degrade,
    });

    const provider = this.turnProvider;
    if (!provider || !snapshot.relayAvailable) {
      if (input.protectIp) {
        throw AppError.of('call.relayUnavailable');
      }
      return stunOnly();
    }

    let credential;
    try {
      credential = await provider.generate(TURN_TTL_SECONDS);
    } catch (err) {
      logger.warn({ err: describeError(err), callId: call.id }, 'TURN credential issuance failed');
      if (input.protectIp) {
        throw AppError.of('call.relayUnavailable');
      }
      return stunOnly();
    }

    const previousUsername = role === 'caller' ? call.turnUsername : call.calleeTurnUsername;
    const recorded = await this.repository.recordTurnIssued(call.id, role, credential.username);
    this.budget.invalidate();
    if (!recorded) {
      await provider.revoke(credential.username).catch(() => undefined);
      throw AppError.of('call.invalidState');
    }
    if (previousUsername) {
      await provider.revoke(previousUsername).catch(() => undefined);
    }

    return {
      callId: call.id,
      iceServers: credential.iceServers,
      expiresAt,
      relayOnly: input.protectIp,
      degrade: snapshot.degrade,
    };
  }

  private requireEnabled(): void {
    if (!this.enabled) {
      throw AppError.of('call.disabled');
    }
  }

  private resolveCallee(room: RoomRecord, callerId: string): string | null {
    if (room.type !== 'private' || room.participants.length !== 2 || !room.participants.includes(callerId)) {
      return null;
    }
    if (room.participants.includes(ASSISTANT_USER_ID)) {
      return null;
    }
    const calleeId = room.participants.find((id) => id !== callerId);
    if (!calleeId || this.roomService.isBlocked(room, callerId)) {
      return null;
    }
    return calleeId;
  }

  private async requireParticipant(callId: string, userId: string, requiredRole?: CallRole): Promise<CallRecord> {
    const call = await this.repository.findById(callId);
    if (!call) {
      throw AppError.of('call.notFound');
    }
    const role = roleOf(call, userId);
    if (!role || (requiredRole && role !== requiredRole)) {
      throw AppError.of('call.notAllowed');
    }
    return call;
  }

  private async rejectBusy(newCall: Parameters<CallRepository['insertEnded']>[0]): Promise<void> {
    await this.repository.insertEnded(newCall, 'busy');
    const ended = await this.repository.findById(newCall.id);
    if (ended) {
      this.io.to(userRoom(ended.callerId)).emit('call:ended', {
        callId: ended.id,
        reason: 'busy',
        endedAt: ended.endedAt ?? newCall.createdAt,
      });
      await this.postSystemMessage(ended);
    }
  }

  private async finish(callId: string, event: CallEvent, endedAtMs: number = this.now()): Promise<CallRecord | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const call = await this.repository.findById(callId);
      if (!call) {
        return null;
      }
      const next = transition(call.state, event);
      if (!next?.endReason) {
        return null;
      }
      const ended = await this.repository.end(callId, call.state, next.endReason, new Date(endedAtMs).toISOString());
      if (ended) {
        await this.afterEnd(ended);
        return ended;
      }
    }
    return null;
  }

  private async afterEnd(call: CallRecord): Promise<void> {
    this.bindings.delete(call.id);
    this.limiter.forgetCall(call.id);

    const payload = { callId: call.id, reason: call.endReason ?? 'failed', endedAt: call.endedAt ?? new Date(this.now()).toISOString() };
    this.io.to(userRoom(call.callerId)).to(userRoom(call.calleeId)).emit('call:ended', payload);

    await this.recordUsage(call);
    await this.postSystemMessage(call);
    await this.revokeCredentials(call);
  }

  private async recordUsage(call: CallRecord): Promise<void> {
    if (call.relayUsed <= 0 || !call.answeredAt || !call.endedAt) {
      return;
    }
    const durationMs = Date.parse(call.endedAt) - Date.parse(call.answeredAt);
    const bytes = estimateRelayBytes(durationMs, call.relayUsed);
    try {
      await this.repository.addUsage(monthKey(Date.parse(call.endedAt)), bytes);
      this.budget.invalidate();
    } catch (err) {
      logger.error({ err, callId: call.id }, 'Failed to record call usage');
    }
  }

  private async postSystemMessage(call: CallRecord): Promise<void> {
    try {
      const base = { kind: call.kind, callerId: call.callerId, reason: call.endReason ?? 'failed' };
      const event = call.answeredAt
        ? systemEvent('call.ended', {
            ...base,
            durationSec: String(Math.max(0, Math.round((Date.parse(call.endedAt ?? call.answeredAt) - Date.parse(call.answeredAt)) / 1000))),
          })
        : systemEvent('call.missed', base);
      const room = await this.roomService.getRoomById(call.roomId);
      const message = await this.messageService.createSystemMessage(call.roomId, event);
      this.io.to(call.roomId).emit('message:new', await this.messageService.toView(message));
      if (room) {
        await this.revealRoom(room, message.timestamp);
      }
    } catch (err) {
      logger.error({ err, callId: call.id }, 'Failed to record call system message');
    }
  }

  private async revealRoom(room: RoomRecord, messageTimestamp: string): Promise<void> {
    const newlyVisible = room.participants.filter((id) => !room.visibleTo.includes(id));
    if (newlyVisible.length === 0) {
      return;
    }
    const reactivatedBefore = new Date(new Date(messageTimestamp).getTime() - 1000).toISOString();
    const updated = (await this.roomService.makeVisibleForAll(room, reactivatedBefore)) ?? room;
    for (const userId of newlyVisible) {
      if (listUserSockets(this.io, userId).length === 0) {
        continue;
      }
      const after = this.roomService.getVisibilityCutoff(updated, userId);
      const [summary, { messages: page }] = await Promise.all([
        this.roomService.buildSummary(updated, userId),
        this.messageService.getRoomMessagesPage(room.id, { after, limit: INITIAL_MESSAGES_LIMIT }),
      ]);
      await joinUserSocketsToRoom(this.io, userId, room.id);
      emitToUser(this.io, userId).emit('room:new', { room: summary, messages: await this.messageService.toViews(page) });
    }
  }

  private async revokeCredentials(call: CallRecord): Promise<void> {
    const usernames = [call.turnUsername, call.calleeTurnUsername].filter((name): name is string => Boolean(name));
    if (usernames.length === 0 || call.turnRevokedAt) {
      return;
    }
    const provider = this.turnProvider;
    if (!provider) {
      await this.repository.markRevoked(call.id, new Date(this.now()).toISOString());
      return;
    }
    const results = await Promise.allSettled(usernames.map((username) => provider.revoke(username)));
    if (results.every((result) => result.status === 'fulfilled')) {
      await this.repository.markRevoked(call.id, new Date(this.now()).toISOString());
    }
  }

  async sweepOpenCalls(): Promise<void> {
    const current = this.now();
    for (const call of await this.repository.findOpen()) {
      if (call.state === 'ringing') {
        if (current - Date.parse(call.createdAt) >= RING_TIMEOUT_MS) {
          await this.finish(call.id, { type: 'ring-timeout' }, Date.parse(call.createdAt) + RING_TIMEOUT_MS);
        }
        continue;
      }

      if (call.answeredAt && current - Date.parse(call.answeredAt) >= MAX_CALL_DURATION_MS) {
        await this.finish(call.id, { type: 'max-duration' }, Date.parse(call.answeredAt) + MAX_CALL_DURATION_MS);
        continue;
      }

      const lastBeat = Date.parse(call.lastHeartbeatAt ?? call.answeredAt ?? call.createdAt);
      if (current >= this.graceUntil && current - lastBeat >= HEARTBEAT_TIMEOUT_MS) {
        await this.finish(call.id, { type: 'heartbeat-timeout' }, lastBeat);
      }
    }
  }

  async sweepCredentials(): Promise<void> {
    const pending = await this.repository.findEndedWithUnrevokedCredentials(REVOKE_SWEEP_BATCH);
    for (const call of pending) {
      const expired = call.endedAt !== null && this.now() - Date.parse(call.endedAt) > TURN_TTL_SECONDS * 1000;
      if (expired && this.turnProvider) {
        await this.repository.markRevoked(call.id, new Date(this.now()).toISOString());
        continue;
      }
      await this.revokeCredentials(call);
    }
  }
}

function assertEnvelopeSize(envelope: string): void {
  if (envelope.length > MAX_ENVELOPE_LENGTH) {
    throw AppError.of('call.signalTooLarge');
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}
