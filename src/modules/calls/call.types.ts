export type CallKind = 'voice' | 'video';

export type CallState = 'ringing' | 'accepted' | 'active' | 'ended';

export type CallEndReason = 'completed' | 'missed' | 'declined' | 'cancelled' | 'busy' | 'failed' | 'connection-lost';

export type CallRole = 'caller' | 'callee';

export type CallDegrade = 'none' | 'video-360' | 'audio-only-relay';

export const RING_TIMEOUT_MS = 45_000;
export const HEARTBEAT_TIMEOUT_MS = 90_000;
export const TAKEOVER_SILENCE_MS = 75_000;
export const PEER_RESUME_GRACE_MS = 180_000;
export const PEER_PRESENCE_MS = 30_000;
export const TRANSFER_PENDING_MS = 15_000;
export const MAX_CALL_DURATION_MS = 4 * 60 * 60 * 1000;
export const RESTART_GRACE_MS = 60_000;
export const MAX_ENVELOPE_LENGTH = 16 * 1024;
export const TURN_TTL_SECONDS = 60 * 60;
export const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export interface CallRecord {
  id: string;
  roomId: string;
  callerId: string;
  calleeId: string;
  kind: CallKind;
  state: CallState;
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  endReason: CallEndReason | null;
  lastHeartbeatAt: string | null;
  acceptedDeviceId: string | null;
  relayUsed: number;
  turnUsername: string | null;
  calleeTurnUsername: string | null;
  turnRevokedAt: string | null;
  callerRelayMs: number;
  calleeRelayMs: number;
  callerRelaySince: string | null;
  calleeRelaySince: string | null;
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}
