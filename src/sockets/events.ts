import type { Server, Socket } from 'socket.io';
import type { PublicUser, UserStatus } from '../models/user.model.js';

export interface ServerToClientEvents {
  'user:registered': (payload: { user: PublicUser }) => void;
  'user:online': (payload: { userId: string; nickname: string; avatar: number }) => void;
  'user:offline': (payload: {
    userId: string;
    user: { id: string; status: UserStatus; lastSeen: string };
  }) => void;
  error: (payload: { message: string }) => void;
}

export interface ClientToServerEvents {
  'user:join': (payload: { nickname?: string; avatar?: number; loginCode?: string | null }) => void;
}

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
