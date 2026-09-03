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
  'user:blocked': (payload: BlockStatusPayload) => void;
  'user:unblocked': (payload: BlockStatusPayload) => void;
}

export interface RoomClientToServerEvents {
  'room:create-private': (payload: { targetNickname: string }) => void;
  'room:create-group': (payload: { roomName: string }) => void;
  'room:join-by-code': (payload: { roomCode: string }) => void;
  'room:join': (payload: { roomId: string }) => void;
  'room:delete': (payload: { roomId: string }) => void;
  'rooms:get': () => void;
  'group:leave': (payload: { roomId: string }) => void;
  'user:block': (payload: { roomId: string; blockedUserId: string }) => void;
  'user:unblock': (payload: { roomId: string; blockedUserId: string }) => void;
}
