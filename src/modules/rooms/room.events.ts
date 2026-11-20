import type { ErrorCode } from '../../lib/error-catalog.js';
import type { InviteProofView, RoomInviteView, RoomRosterView } from './room.invites.js';
import type { RoomParticipant, RoomSummary } from './room.types.js';

export interface BlockStatusPayload {
  roomId: string;
  blockedUserId?: string;
  blockedByUserId?: string;
  blockedBy: Record<string, string>;
  isBlocking: boolean;
}

export interface RoomKeyDelivery {
  roomId: string;
  keyId: string;
  epoch: number;
  senderId: string;
  sealedKey: string;
  roster?: string;
}

export interface RoomKeyRejection {
  roomId: string;
  keyId: string;
  epoch: number;
  currentEpoch: number;
  currentKeyId: string | null;
  event: 'e2e:publish-room-key' | 'e2e:share-room-key';
  rotationRequiredEpoch: number | null;
  code: ErrorCode;
  message: string;
  retryAfterMs?: number;
}

export interface RoomServerToClientEvents {
  'room:joined': (payload: { room: RoomSummary; messages: unknown[] }) => void;
  'room:new': (payload: { room: RoomSummary; messages: unknown[] }) => void;
  'room:created': (payload: { room: RoomSummary; messages: unknown[] }) => void;
  'room:deleted': (payload: { roomId: string }) => void;
  'rooms:list': (payload: { rooms: RoomSummary[] }) => void;
  'group:user-joined': (payload: { roomId: string; participants: RoomParticipant[] }) => void;
  'group:left': (payload: { roomId: string }) => void;
  'group:user-left': (payload: {
    roomId: string;
    userId: string;
    userName: string;
    participants: RoomParticipant[];
  }) => void;
  'group:participants-updated': (payload: { roomId: string; participants: RoomParticipant[] }) => void;
  'user:blocked': (payload: BlockStatusPayload) => void;
  'user:unblocked': (payload: BlockStatusPayload) => void;
  'e2e:room-keys': (payload: { keys: RoomKeyDelivery[]; truncated?: boolean }) => void;
  'e2e:room-key': (payload: RoomKeyDelivery) => void;
  'e2e:key-request': (payload: { roomId: string; requesterId: string; proof?: string }) => void;
  'e2e:room-key-rejected': (payload: RoomKeyRejection) => void;
  'e2e:rotation-required': (payload: { roomId: string; epoch: number; memberIds?: string[]; inviteProofs?: InviteProofView[] }) => void;
  'room:invite-updated': (payload: { roomId: string; invite: RoomInviteView | null; roster: RoomRosterView | null }) => void;
  'room:name-updated': (payload: { roomId: string; encryptedName: string; keyId: string }) => void;
}

export interface RoomClientToServerEvents {
  'room:create-private': (payload: { targetNickname: string }) => void;
  'room:create-group': (payload?: Record<string, never>) => void;
  'room:rename': (payload: { roomId: string; name: string; keyId: string }) => void;
  'room:join-by-code': (payload: { roomCode: string }) => void;
  'room:join-by-invite': (payload: { roomId: string; inviteToken: string; proof: string; attestation?: string }) => void;
  'room:reset-invite': (payload: { roomId: string }) => void;
  'room:join': (payload: { roomId: string }) => void;
  'room:delete': (payload: { roomId: string }) => void;
  'rooms:get': () => void;
  'group:leave': (payload: { roomId: string; attestation?: string }) => void;
  'group:remove-member': (payload: { roomId: string; userId: string; attestation?: string }) => void;
  'group:promote-admin': (payload: { roomId: string; userId: string; attestation?: string }) => void;
  'user:block': (payload: { roomId: string; blockedUserId: string }) => void;
  'user:unblock': (payload: { roomId: string; blockedUserId: string }) => void;
  'e2e:publish-room-key': (payload: {
    roomId: string;
    keyId: string;
    epoch: number;
    keys: { userId: string; sealedKey: string }[];
    invite?: { tokenHash: string; encryptedInvite: string };
    roster?: string;
    name?: string;
  }) => void;
  'e2e:share-room-key': (payload: {
    roomId: string;
    keyId: string;
    epoch: number;
    keys: { userId: string; sealedKey: string }[];
  }) => void;
  'e2e:get-room-keys': (payload: { roomIds: string[]; keyIds?: Record<string, string[]> }) => void;
  'e2e:request-room-key': (payload: { roomId: string }) => void;
  'e2e:report-bad-key': (payload: { roomId: string; keyId: string }) => void;
}
