import type { PublicUser, UserStatus } from './user.model.js';

export interface UserServerToClientEvents {
  'user:registered': (payload: { user: PublicUser }) => void;
  'user:online': (payload: { userId: string; nickname: string; avatar: number }) => void;
  'user:offline': (payload: {
    userId: string;
    user: { id: string; status: UserStatus; lastSeen: string };
  }) => void;
  error: (payload: { message: string }) => void;
}

export interface UserClientToServerEvents {
  'user:join': (payload: { nickname?: string; avatar?: number; loginCode?: string | null }) => void;
}
