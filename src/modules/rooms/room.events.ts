import type { RoomParticipant, RoomSummary } from './room.types.js';

export interface BlockStatusPayload {
  roomId: string;
  blockedUserId?: string;
  blockedByUserId?: string;
  blockedBy: Record<string, string>;
  isBlocking: boolean;
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
  'e2e:room-keys': (payload: { keys: { roomId: string; sealedKey: string }[] }) => void;
  'e2e:room-key': (payload: { roomId: string; sealedKey: string }) => void;
  'e2e:key-request': (payload: { roomId: string; requesterId: string }) => void;
}

export interface RoomClientToServerEvents {
  'room:create-private': (payload: { targetNickname: string }) => void;
  'room:create-group': (payload: { roomName: string }) => void;
  'room:join-by-code': (payload: { roomCode: string }) => void;
  'room:join': (payload: { roomId: string }) => void;
  'room:delete': (payload: { roomId: string }) => void;
  'rooms:get': () => void;
  'group:leave': (payload: { roomId: string }) => void;
  'group:remove-member': (payload: { roomId: string; userId: string }) => void;
  'group:promote-admin': (payload: { roomId: string; userId: string }) => void;
  'user:block': (payload: { roomId: string; blockedUserId: string }) => void;
  'user:unblock': (payload: { roomId: string; blockedUserId: string }) => void;
  'e2e:publish-room-key': (payload: { roomId: string; keys: { userId: string; sealedKey: string }[] }) => void;
  'e2e:get-room-keys': (payload: { roomIds: string[] }) => void;
  'e2e:request-room-key': (payload: { roomId: string }) => void;
}
