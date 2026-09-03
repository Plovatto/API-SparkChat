import type { AuthMethod, PublicUser, SessionSummary, UserStatus, UserTheme } from './user.model.js';

export interface UserServerToClientEvents {
  'user:registered': (payload: { user: PublicUser; sessionToken: string; recoveryFile: string; authMethod: AuthMethod }) => void;
  'user:resumed': (payload: { user: PublicUser; authMethod: AuthMethod }) => void;
  'user:online': (payload: { userId: string; nickname: string; avatar: number }) => void;
  'user:offline': (payload: {
    userId: string;
    user: { id: string; status: UserStatus; lastSeen: string };
  }) => void;
  'user:profile-updated': (payload: { userId: string; nickname: string; avatar: number; statusText: string | null }) => void;
  'user:profile-updated-success': (payload: { user: PublicUser; recoveryFile: string | null }) => void;
  'user:password-changed': (payload: { recoveryFile: string }) => void;
  'user:recovery-file-regenerated': (payload: { recoveryFile: string }) => void;
  'user:sessions': (payload: { sessions: SessionSummary[] }) => void;
  error: (payload: { message: string; clientTempId?: string | undefined }) => void;
}

export interface UserClientToServerEvents {
  'user:join': (
    payload:
      | { mode: 'register'; nickname: string; avatar: number; password: string }
      | { mode: 'resume'; userId: string; sessionToken: string },
  ) => void;
  'user:update-profile': (payload: { nickname: string; avatar: number }) => void;
  'user:update-status-text': (payload: { statusText: string }) => void;
  'user:update-theme': (payload: UserTheme) => void;
  'user:visibility': (payload: { visible: boolean }) => void;
  'user:change-password': (payload: { currentPassword?: string; newPassword: string }) => void;
  'user:regenerate-recovery-file': () => void;
  'user:list-sessions': () => void;
  'user:revoke-session': (payload: { sessionId: string }) => void;
}
