import type { PublicUser, UserStatus, UserTheme } from './user.model.js';

export interface UserServerToClientEvents {
  'user:registered': (payload: { user: PublicUser }) => void;
  'user:online': (payload: { userId: string; nickname: string; avatar: number }) => void;
  'user:offline': (payload: {
    userId: string;
    user: { id: string; status: UserStatus; lastSeen: string };
  }) => void;
  'user:profile-updated': (payload: { userId: string; nickname: string; avatar: number }) => void;
  'user:profile-updated-success': (payload: { user: PublicUser }) => void;
  error: (payload: { message: string }) => void;
}

export interface UserClientToServerEvents {
  'user:join': (payload: { nickname?: string; avatar?: number; loginCode?: string | null }) => void;
  'user:update-profile': (payload: { nickname: string; avatar: number }) => void;
  'user:update-theme': (payload: UserTheme) => void;
}
