import type { Server, Socket } from 'socket.io';
import type { MessageClientToServerEvents, MessageServerToClientEvents } from '../modules/messages/index.js';
import type { RoomClientToServerEvents, RoomServerToClientEvents } from '../modules/rooms/index.js';
import type { AuthMethod, UserClientToServerEvents, UserServerToClientEvents } from '../modules/users/index.js';

export type ServerToClientEvents = UserServerToClientEvents & RoomServerToClientEvents & MessageServerToClientEvents;

export type ClientToServerEvents = UserClientToServerEvents & RoomClientToServerEvents & MessageClientToServerEvents;

export type InterServerEvents = Record<string, never>;

export interface SocketData {
  userId?: string;
  authMethod?: AuthMethod;
  sessionId?: string;
}

export type AppServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
