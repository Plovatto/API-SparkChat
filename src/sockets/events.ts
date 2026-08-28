import type { Server, Socket } from 'socket.io';
import type { UserClientToServerEvents, UserServerToClientEvents } from '../modules/users/user.events.js';

export type ServerToClientEvents = UserServerToClientEvents;

export type ClientToServerEvents = UserClientToServerEvents;

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
