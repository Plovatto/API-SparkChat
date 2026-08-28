import type { Server, Socket } from 'socket.io';
import type { RoomClientToServerEvents, RoomServerToClientEvents } from '../modules/rooms/room.events.js';
import type { UserClientToServerEvents, UserServerToClientEvents } from '../modules/users/user.events.js';

export interface ServerToClientEvents extends UserServerToClientEvents, RoomServerToClientEvents {}

export interface ClientToServerEvents extends UserClientToServerEvents, RoomClientToServerEvents {}

export type InterServerEvents = Record<string, never>;

export interface SocketData {
  userId?: string;
}

export type AppServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
