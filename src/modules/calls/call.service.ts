import { logger } from '../../config/logger.js';
import { AppError } from '../../lib/app-error.js';
import type { AppServer } from '../../sockets/events.js';
import { emitToUser, joinUserSocketsToRoom, listUserSockets, userRoom } from '../../sockets/user-sockets.js';
import { INITIAL_MESSAGES_LIMIT, systemEvent, type MessageService } from '../messages/index.js';
import type { RoomRecord, RoomService } from '../rooms/index.js';
import { ASSISTANT_USER_ID } from '../users/index.js';
import { monthKey, type CallBudget } from './call-budget.js';
import type { CallMediaState, CallServerToClientEvents, CallStatePayload } from './call.events.js';
import type { CallRateLimiter } from './call.rate-limiter.js';
import type { CallRepository } from './call.repository.js';
import { transition, type CallEvent } from './call.state.js';
import {
  HEARTBEAT_TIMEOUT_MS,
  PEER_PRESENCE_MS,
  PEER_RESUME_GRACE_MS,
  TAKEOVER_SILENCE_MS,
  TRANSFER_PENDING_MS,
  MAX_CALL_DURATION_MS,
  MAX_ENVELOPE_LENGTH,
  RESTART_GRACE_MS,
  RING_TIMEOUT_MS,
  TURN_TTL_SECONDS,
  type CallDegrade,
  type CallEndReason,
  type CallKind,
  type CallRecord,
  type CallRole,
  type IceServer,
} from './call.types.js';
import { STUN_ONLY_SERVERS, type TurnProvider } from './turn-credentials.js';

const SWEEP_INTERVAL_MS = 2000;
const REVOKE_SWEEP_BATCH = 50;
const MONTHLY_RELAY_SECONDS_PER_USER = 20 * 60 * 60;
const DAILY_RELAY_SECONDS_PER_USER = 6 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const SIGNAL_QUEUE_TTL_MS = 15_000;
const SIGNAL_QUEUE_LIMIT = 64;

export interface CallActor {
  userId: string;
  socketId: string;
}

export interface CallPushNotifier {
  incomingCall(input: { userId: string; callId: string; roomId: string; kind: CallKind; ringExpiresAtMs: number }): void;
  callEnded(input: { userId: string; callId: string; reason: CallEndReason | 'answered' }): void;
}

export interface CallServiceOptions {
  enabled?: boolean;
  now?: () => number;
  push?: CallPushNotifier;
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

interface QueuedSignal {
  role: CallRole;
  at: number;
  payload: { callId: string; from: string; envelope: string };
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
  private readonly beats = new Map<string, Partial<Record<CallRole, number>>>();
  private readonly mediaStates = new Map<string, Partial<Record<CallRole, CallMediaState>>>();
  private readonly connectedAt = new Map<string, number>();
  private readonly pendingTransfers = new Map<string, { role: CallRole; socketId: string; startedAt: number }>();
  private readonly ringingInvites = new Map<string, IncomingCallPayload>();
  private readonly pending = new Map<string, QueuedSignal[]>();
  private readonly now: () => number;
  private readonly enabled: boolean;
  private readonly graceUntil: number;
  private readonly push: CallPushNotifier | null;

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
    this.push = options.push ?? null;
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
    this.expirePendingTransfers();
    await this.sweepOpenCalls();
    await this.sweepCredentials();
    this.limiter.purge();
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
    try {
      if (room) {
        await this.revealRoom(room, newCall.createdAt);
      }
    } catch (err) {
      logger.error({ err, callId: input.callId }, 'Failed to reveal the room for an incoming call');
    }
    const incoming: IncomingCallPayload = {
      callId: input.callId,
      roomId: input.roomId,
      kind: input.kind,
      callerId: actor.userId,
      envelope: input.envelope,
      ringExpiresAt: new Date(createdAtMs + RING_TIMEOUT_MS).toISOString(),
    };
    this.ringingInvites.set(input.callId, incoming);
    this.io.to(userRoom(calleeId)).emit('call:incoming', incoming);
    this.push?.incomingCall({
      userId: calleeId,
      callId: input.callId,
      roomId: input.roomId,
      kind: input.kind,
      ringExpiresAtMs: createdAtMs + RING_TIMEOUT_MS,
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

    this.ringingInvites.delete(call.id);
    const bindings = this.bindings.get(call.id) ?? {};
    bindings.callee = actor.socketId;
    this.bindings.set(call.id, bindings);

    this.io.to(userRoom(call.callerId)).emit('call:accepted', { callId: call.id, envelope: input.envelope, deviceId: actor.socketId });
    this.io.to(actor.socketId).emit('call:accepted', { callId: call.id, envelope: input.envelope, deviceId: actor.socketId });
    this.io.in(userRoom(call.calleeId)).except(actor.socketId).emit('call:answered-elsewhere', { callId: call.id });
    this.push?.callEnded({ userId: call.calleeId, callId: call.id, reason: 'answered' });
  }

  async decline(actor: CallActor, callId: string): Promise<void> {
    this.requireEnabled();
    const call = await this.requireParticipant(callId, actor.userId, 'callee');
    if (call.state !== 'ringing') {
      throw AppError.of('call.invalidState');
    }
    const ended = await this.finish(callId, { type: 'decline' });
    if (ended) {
      this.io.in(userRoom(call.calleeId)).except(actor.socketId).emit('call:declined-elsewhere', { callId });
    }
  }

  async hangup(actor: CallActor, callId: string, force = false): Promise<void> {
    this.requireEnabled();
    const call = await this.requireParticipant(callId, actor.userId);
    if (call.state === 'ended') {
      return;
    }
    const role = roleOf(call, actor.userId);
    if (role && !force && (call.state === 'accepted' || call.state === 'active')) {
      if (!this.mayTakeOver(call, role, actor.socketId)) {
        throw AppError.of('call.notAllowed');
      }
    }
    const ended = await this.finish(callId, { type: 'hangup', by: role ?? 'caller' });
    if (ended && role === 'callee' && call.state === 'ringing') {
      this.io.in(userRoom(call.calleeId)).except(actor.socketId).emit('call:declined-elsewhere', { callId });
    }
  }

  async transfer(actor: CallActor, input: { callId: string; envelope: string }): Promise<void> {
    this.requireEnabled();
    assertEnvelopeSize(input.envelope);
    const call = await this.requireParticipant(input.callId, actor.userId);
    const role = roleOf(call, actor.userId);
    if (!role) {
      throw AppError.of('call.notAllowed');
    }
    if (call.state !== 'accepted' && call.state !== 'active') {
      throw AppError.of('call.invalidState');
    }
    const previous = this.boundSocket(call, role);
    if (previous === actor.socketId) {
      throw AppError.of('call.invalidState');
    }
    const peerRole: CallRole = role === 'caller' ? 'callee' : 'caller';
    const peerSocket = this.boundSocket(call, peerRole);
    if (peerSocket === undefined || !this.io.sockets.sockets.has(peerSocket)) {
      throw AppError.of('call.invalidState');
    }
    this.expirePendingTransfers();
    const pending = this.pendingTransfers.get(call.id);
    if (pending && this.io.sockets.sockets.has(pending.socketId)) {
      throw AppError.of('call.invalidState');
    }
    if (!this.limiter.tryTransfer(call.id)) {
      throw AppError.of('call.rateLimited');
    }
    this.clearPendingTransfer(call.id);
    this.pendingTransfers.set(call.id, { role, socketId: actor.socketId, startedAt: this.now() });
    this.io.to(peerSocket).emit('call:peer-transfer', { callId: call.id, from: actor.userId, envelope: input.envelope });
  }

  private expirePendingTransfers(): void {
    const current = this.now();
    for (const [callId, pending] of this.pendingTransfers) {
      if (current - pending.startedAt >= TRANSFER_PENDING_MS) {
        this.pendingTransfers.delete(callId);
        this.io.to(pending.socketId).emit('call:transfer-failed', { callId });
      }
    }
  }

  private clearPendingTransfer(callId: string): void {
    this.pendingTransfers.delete(callId);
  }

  async transferAccept(actor: CallActor, input: { callId: string; envelope: string }): Promise<void> {
    this.requireEnabled();
    assertEnvelopeSize(input.envelope);
    const call = await this.requireParticipant(input.callId, actor.userId);
    const role = roleOf(call, actor.userId);
    if (!role) {
      throw AppError.of('call.notAllowed');
    }
    if (call.state !== 'accepted' && call.state !== 'active') {
      throw AppError.of('call.invalidState');
    }
    this.requireBoundSocket(call, role, actor.socketId);
    this.markBeat(call.id, role);
    const movingRole: CallRole = role === 'caller' ? 'callee' : 'caller';
    this.expirePendingTransfers();
    const pending = this.pendingTransfers.get(call.id);
    if (!pending || pending.role !== movingRole || !this.io.sockets.sockets.has(pending.socketId)) {
      this.clearPendingTransfer(call.id);
      throw AppError.of('call.invalidState');
    }
    this.clearPendingTransfer(call.id);
    const previous = this.boundSocket(call, movingRole);
    this.forgetMedia(call.id, movingRole);
    await this.takeOver(call, movingRole, pending.socketId);
    this.limiter.allowNextIceServers(call.id, roleUserId(call, movingRole), pending.socketId);
    if (previous !== undefined && previous !== pending.socketId) {
      this.io.to(previous).emit('call:transferred', { callId: call.id });
    }
    this.io.to(pending.socketId).emit('call:transfer-accepted', { callId: call.id, envelope: input.envelope });
    const oldUsernames = splitUsernames(movingRole === 'caller' ? call.turnUsername : call.calleeTurnUsername);
    if (this.turnProvider && oldUsernames.length > 0) {
      void this.revokeUsernames(this.turnProvider, oldUsernames).catch(() => undefined);
    }
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

    this.requireBoundSocket(call, role, actor.socketId);
    this.markBeat(call.id, role);

    if (role === 'callee' && call.state === 'accepted') {
      await this.repository.markActive(call.id);
    }

    const peerRole: CallRole = role === 'caller' ? 'callee' : 'caller';
    const payload = { callId: call.id, from: actor.userId, envelope: input.envelope };
    const peerSocket = this.boundSocket(call, peerRole);
    if (peerSocket !== undefined && this.io.sockets.sockets.has(peerSocket)) {
      this.io.to(peerSocket).emit('call:signal', payload);
      return;
    }
    this.enqueueSignal(call.id, peerRole, payload);
  }

  async heartbeat(actor: CallActor, callId: string, relayed?: boolean, media?: CallMediaState): Promise<void> {
    this.requireEnabled();
    const call = await this.requireParticipant(callId, actor.userId);
    if (call.state === 'accepted' || call.state === 'active') {
      const role = roleOf(call, actor.userId);
      if (!role) {
        throw AppError.of('call.notAllowed');
      }
      if (this.boundSocket(call, role) !== actor.socketId) {
        if (!this.mayTakeOver(call, role, actor.socketId)) {
          throw AppError.of('call.notAllowed');
        }
        await this.takeOver(call, role, actor.socketId);
        if (media) {
          await this.rememberMedia(call, role, actor.socketId, media);
        } else {
          this.forgetMedia(call.id, role);
        }
        return;
      }
      this.markBeat(call.id, role);
      await this.rememberMedia(call, role, actor.socketId, media);
      await this.repository.touchHeartbeat(callId, new Date(this.now()).toISOString());
      if (relayed === false) {
        await this.dropRelayCredentials(call, role);
      }
    }
  }

  private async rememberMedia(call: CallRecord, role: CallRole, socketId: string, media: CallMediaState | undefined): Promise<void> {
    if (!media) {
      return;
    }
    const known = this.mediaStates.get(call.id);
    const previous = known?.[role];
    const states = known ?? {};
    states[role] = { muted: media.muted, camera: media.camera };
    this.mediaStates.set(call.id, states);
    if (!known) {
      const current = await this.repository.findById(call.id);
      if (!current || current.state === 'ended') {
        this.mediaStates.delete(call.id);
        return;
      }
    }
    if (!previous || previous.muted !== media.muted || previous.camera !== media.camera) {
      this.io.in(userRoom(roleUserId(call, role))).except(socketId).emit('call:state', this.statePayload(call, call.state === 'accepted' ? 'accepted' : 'active', role, null));
    }
  }

  private forgetMedia(callId: string, role: CallRole): void {
    const states = this.mediaStates.get(callId);
    if (!states) {
      return;
    }
    delete states[role];
    if (!states.caller && !states.callee) {
      this.mediaStates.delete(callId);
    }
  }

  private markBeat(callId: string, role: CallRole): void {
    const beats = this.beats.get(callId) ?? {};
    beats[role] = this.now();
    this.beats.set(callId, beats);
  }

  private lastBeatOf(call: CallRecord, role: CallRole): number {
    return this.beats.get(call.id)?.[role] ?? Date.parse(call.lastHeartbeatAt ?? call.answeredAt ?? call.createdAt);
  }

  private mayTakeOver(call: CallRecord, role: CallRole, socketId: string): boolean {
    return this.canTakeOver(call, role, socketId) || this.now() - this.lastBeatOf(call, role) >= TAKEOVER_SILENCE_MS;
  }

  private async takeOver(call: CallRecord, role: CallRole, socketId: string): Promise<void> {
    const bindings = this.bindings.get(call.id) ?? {};
    bindings[role] = socketId;
    this.bindings.set(call.id, bindings);
    if (role === 'callee') {
      await this.repository.rebindAcceptedDevice(call.id, socketId);
    }
    this.markBeat(call.id, role);
    await this.repository.touchHeartbeat(call.id, new Date(this.now()).toISOString());
    this.flushSignals(call.id, role, socketId);
  }

  async sync(actor: CallActor, currentCallId?: string | null): Promise<void> {
    this.io.to(actor.socketId).emit('call:config', await this.getConfig());
    this.requireEnabled();
    const call = await this.repository.findOpenForUser(actor.userId);
    const role = call ? roleOf(call, actor.userId) : null;
    if (!call || !role || call.state === 'ended') {
      this.io.to(actor.socketId).emit('call:state', null);
      return;
    }

    const inCall = currentCallId === undefined || currentCallId === call.id;
    if (inCall && (call.state === 'accepted' || call.state === 'active')) {
      if (this.canTakeOver(call, role, actor.socketId)) {
        await this.takeOver(call, role, actor.socketId);
      }
    }

    const payload = this.statePayload(call, call.state, role, actor.socketId);
    this.io.to(actor.socketId).emit('call:state', payload);
    const invite = this.ringingInvites.get(call.id);
    if (call.state === 'ringing' && role === 'callee' && invite && Date.parse(invite.ringExpiresAt) > this.now()) {
      this.io.to(actor.socketId).emit('call:incoming', invite);
    }
  }

  private statePayload(call: CallRecord, state: CallStatePayload['state'], role: CallRole, socketId: string | null): CallStatePayload {
    const payload: CallStatePayload = {
      callId: call.id,
      state,
      roomId: call.roomId,
      kind: call.kind,
      peerId: peerOf(call, role),
      role,
      answeredAt: call.answeredAt,
      transferable: this.isTransferable(call, role, socketId ?? ''),
      peerLive: this.isPeerLive(call, role),
    };
    const media = this.mediaStates.get(call.id)?.[role];
    if (media && (call.state === 'accepted' || call.state === 'active')) {
      payload.media = { ...media };
    }
    return payload;
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
    if (!this.limiter.tryIceServers(call.id, actor.userId, actor.socketId)) {
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
    const userExhausted = provider !== null && snapshot.relayAvailable && (await this.userRelayExhausted(actor.userId));
    if (!provider || !snapshot.relayAvailable || userExhausted) {
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

    const previous = splitUsernames(role === 'caller' ? call.turnUsername : call.calleeTurnUsername);
    const stillPending = previous.length > 0 ? await this.revokeUsernames(provider, previous) : [];
    const recorded = await this.repository.recordTurnIssued(call.id, role, [credential.username, ...stillPending].join(','), new Date(this.now()).toISOString());
    this.budget.invalidate();
    if (!recorded) {
      await provider.revoke(credential.username).catch(() => undefined);
      throw AppError.of('call.invalidState');
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
      const ended = await this.repository.end(callId, call.state, next.endReason, new Date(endedAtMs).toISOString(), {
        markRevoked: this.turnProvider === null,
      });
      if (ended) {
        await this.afterEnd(ended);
        return ended;
      }
    }
    return null;
  }

  private async afterEnd(call: CallRecord): Promise<void> {
    this.bindings.delete(call.id);
    this.beats.delete(call.id);
    this.mediaStates.delete(call.id);
    this.connectedAt.delete(call.id);
    this.clearPendingTransfer(call.id);
    this.ringingInvites.delete(call.id);
    this.pending.delete(call.id);
    this.limiter.forgetCall(call.id);

    const payload = { callId: call.id, reason: call.endReason ?? 'failed', endedAt: call.endedAt ?? new Date(this.now()).toISOString() };
    this.io.to(userRoom(call.callerId)).to(userRoom(call.calleeId)).emit('call:ended', payload);
    if (!call.answeredAt) {
      this.push?.callEnded({ userId: call.calleeId, callId: call.id, reason: payload.reason });
    }

    this.budget.invalidate();
    await this.postSystemMessage(call);
    await this.revokeCredentials(call);
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
      if (!room || (!call.answeredAt && !room.visibleTo.includes(call.calleeId))) {
        return;
      }
      const message = await this.messageService.createSystemMessage(call.roomId, event);
      this.io.to(call.roomId).emit('message:new', await this.messageService.toNewView(message));
      await this.revealRoom(room, message.timestamp);
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
        this.messageService.getRoomMessagesPage(room.id, { after, limit: INITIAL_MESSAGES_LIMIT, viewerId: userId }),
      ]);
      await joinUserSocketsToRoom(this.io, userId, room.id);
      emitToUser(this.io, userId).emit('room:new', { room: summary, messages: await this.messageService.toViews(page) });
    }
  }

  private async dropRelayCredentials(call: CallRecord, role: CallRole): Promise<void> {
    const provider = this.turnProvider;
    const stored = role === 'caller' ? call.turnUsername : call.calleeTurnUsername;
    const usernames = splitUsernames(stored);
    const since = role === 'caller' ? call.callerRelaySince : call.calleeRelaySince;
    if (!provider || stored === null || usernames.length === 0 || since === null) {
      return;
    }
    const failed = await this.revokeUsernames(provider, usernames);
    await this.repository.closeRelayWindow(call.id, role, new Date(this.now()).toISOString(), stored, failed.length > 0 ? failed.join(',') : null);
    this.budget.invalidate();
  }

  private async revokeUsernames(provider: TurnProvider, usernames: string[]): Promise<string[]> {
    const results = await Promise.allSettled(usernames.map((username) => provider.revoke(username)));
    return usernames.filter((_, index) => results[index]?.status === 'rejected');
  }

  private async userRelayExhausted(userId: string): Promise<boolean> {
    const current = this.now();
    const monthStart = `${monthKey(current)}-01T00:00:00.000Z`;
    const nowIso = new Date(current).toISOString();
    const dayStart = new Date(current - DAY_MS).toISOString();
    const [monthSeconds, daySeconds] = await Promise.all([
      this.repository.relaySecondsForUser(userId, monthStart, nowIso),
      this.repository.relaySecondsForUser(userId, dayStart, nowIso),
    ]);
    return monthSeconds >= MONTHLY_RELAY_SECONDS_PER_USER || daySeconds >= DAILY_RELAY_SECONDS_PER_USER;
  }

  private requireBoundSocket(call: CallRecord, role: CallRole, socketId: string): void {
    if (this.boundSocket(call, role) !== socketId) {
      throw AppError.of('call.notAllowed');
    }
  }

  private hasConnectedParticipant(call: CallRecord): boolean {
    return (['caller', 'callee'] as const).some((role) => {
      const bound = this.boundSocket(call, role);
      return bound !== undefined && this.io.sockets.sockets.has(bound);
    });
  }

  private boundSocket(call: CallRecord, role: CallRole): string | undefined {
    const bound = this.bindings.get(call.id)?.[role];
    if (bound !== undefined) {
      return bound;
    }
    return role === 'callee' ? (call.acceptedDeviceId ?? undefined) : undefined;
  }

  private isTransferable(call: CallRecord, role: CallRole, socketId: string): boolean {
    if (call.state !== 'accepted' && call.state !== 'active') {
      return false;
    }
    if (this.boundSocket(call, role) === socketId) {
      return false;
    }
    const peerRole: CallRole = role === 'caller' ? 'callee' : 'caller';
    const peerSocket = this.boundSocket(call, peerRole);
    return peerSocket !== undefined && this.io.sockets.sockets.has(peerSocket) && this.now() - this.lastBeatOf(call, peerRole) < PEER_PRESENCE_MS;
  }

  private isPeerLive(call: CallRecord, role: CallRole): boolean {
    if (call.state !== 'accepted' && call.state !== 'active') {
      return true;
    }
    const peerRole: CallRole = role === 'caller' ? 'callee' : 'caller';
    const peerSocket = this.boundSocket(call, peerRole);
    if (peerSocket !== undefined && this.io.sockets.sockets.has(peerSocket)) {
      return true;
    }
    return this.now() - this.lastBeatOf(call, peerRole) < PEER_RESUME_GRACE_MS;
  }

  private canTakeOver(call: CallRecord, role: CallRole, socketId: string): boolean {
    const bound = this.boundSocket(call, role);
    return bound === undefined || bound === socketId || !this.io.sockets.sockets.has(bound);
  }

  private enqueueSignal(callId: string, role: CallRole, payload: QueuedSignal['payload']): void {
    const queue = this.pending.get(callId) ?? [];
    const current = this.now();
    const fresh = queue.filter((entry) => current - entry.at < SIGNAL_QUEUE_TTL_MS);
    if (fresh.length < SIGNAL_QUEUE_LIMIT) {
      fresh.push({ role, at: current, payload });
    }
    this.pending.set(callId, fresh);
  }

  private flushSignals(callId: string, role: CallRole, socketId: string): void {
    const queue = this.pending.get(callId);
    if (!queue) {
      return;
    }
    const current = this.now();
    for (const entry of queue) {
      if (entry.role === role && current - entry.at < SIGNAL_QUEUE_TTL_MS) {
        this.io.to(socketId).emit('call:signal', entry.payload);
      }
    }
    const rest = queue.filter((entry) => entry.role !== role && current - entry.at < SIGNAL_QUEUE_TTL_MS);
    if (rest.length === 0) {
      this.pending.delete(callId);
    } else {
      this.pending.set(callId, rest);
    }
  }

  private async revokeCredentials(call: CallRecord): Promise<void> {
    const usernames = [...splitUsernames(call.turnUsername), ...splitUsernames(call.calleeTurnUsername)];
    if (usernames.length === 0 || call.turnRevokedAt) {
      return;
    }
    const provider = this.turnProvider;
    if (!provider || (await this.revokeUsernames(provider, usernames)).length === 0) {
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

      if (this.hasConnectedParticipant(call)) {
        this.connectedAt.set(call.id, current);
        continue;
      }

      const lastBeat = Math.max(
        Date.parse(call.lastHeartbeatAt ?? call.answeredAt ?? call.createdAt),
        this.connectedAt.get(call.id) ?? 0,
      );
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

type IncomingCallPayload = Parameters<CallServerToClientEvents['call:incoming']>[0];

function roleUserId(call: CallRecord, role: CallRole): string {
  return role === 'caller' ? call.callerId : call.calleeId;
}

function assertEnvelopeSize(envelope: string): void {
  if (envelope.length > MAX_ENVELOPE_LENGTH) {
    throw AppError.of('call.signalTooLarge');
  }
}

function splitUsernames(stored: string | null): string[] {
  return stored ? stored.split(',').filter((name) => name.length > 0) : [];
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}
