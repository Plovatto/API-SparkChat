import type { Server, Socket } from 'socket.io';

export type ServerToClientEvents = Record<string, never>;

export type ClientToServerEvents = Record<string, never>;

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
