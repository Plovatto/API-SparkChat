import type { RoomSummary } from './room.types.js';

export interface RoomServerToClientEvents {
  'room:joined': (payload: { room: RoomSummary; messages: unknown[] }) => void;
  'room:new': (payload: { room: RoomSummary; messages: unknown[] }) => void;
  'room:created': (payload: { room: RoomSummary; messages: unknown[] }) => void;
  'rooms:list': (payload: { rooms: RoomSummary[] }) => void;
}

export interface RoomClientToServerEvents {
  'room:create-private': (payload: { targetChatCode: string }) => void;
  'room:create-group': (payload: { roomName: string }) => void;
  'rooms:get': () => void;
}
