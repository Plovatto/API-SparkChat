import type { CallDegrade, CallEndReason, CallKind, CallRole, CallState, IceServer } from './call.types.js';

export interface CallStatePayload {
  callId: string;
  state: Exclude<CallState, 'ended'>;
  roomId: string;
  kind: CallKind;
  peerId: string;
  role: CallRole;
  answeredAt: string | null;
}

export interface CallClientToServerEvents {
  'call:start': (payload: { callId: string; roomId: string; kind: CallKind; envelope: string }) => void;
  'call:accept': (payload: { callId: string; envelope: string }) => void;
  'call:decline': (payload: { callId: string }) => void;
  'call:silence': (payload: { callId: string }, ack?: () => void) => void;
  'call:hangup': (payload: { callId: string }) => void;
  'call:signal': (payload: { callId: string; to: string; envelope: string }) => void;
  'call:heartbeat': (payload: { callId: string }) => void;
  'call:sync': (payload?: Record<string, never>) => void;
  'call:ice-servers': (payload: { callId: string; protectIp: boolean }) => void;
  'call:transfer': (payload: { callId: string; envelope: string }) => void;
  'call:transfer-accept': (payload: { callId: string; envelope: string }) => void;
}

export interface CallServerToClientEvents {
  'call:config': (payload: { enabled: boolean; relayAvailable: boolean; degrade: CallDegrade }) => void;
  'call:incoming': (payload: { callId: string; roomId: string; kind: CallKind; callerId: string; envelope: string; ringExpiresAt: string }) => void;
  'call:accepted': (payload: { callId: string; envelope: string; deviceId: string }) => void;
  'call:answered-elsewhere': (payload: { callId: string }) => void;
  'call:declined-elsewhere': (payload: { callId: string }) => void;
  'call:signal': (payload: { callId: string; from: string; envelope: string }) => void;
  'call:ended': (payload: { callId: string; reason: CallEndReason; endedAt: string }) => void;
  'call:state': (payload: CallStatePayload | null) => void;
  'call:transferred': (payload: { callId: string }) => void;
  'call:peer-transfer': (payload: { callId: string; from: string; envelope: string }) => void;
  'call:transfer-accepted': (payload: { callId: string; envelope: string }) => void;
  'call:ice-servers-result': (payload: {
    callId: string;
    iceServers: IceServer[];
    expiresAt: string;
    relayOnly: boolean;
    degrade: CallDegrade;
  }) => void;
}
