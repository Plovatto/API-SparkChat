import type { AuthMethod, PublicUser, SessionSummary, UserChatSettings, UserStatus, UserTheme } from './user.model.js';

export interface E2ePublicKeyEntry {
  userId: string;
  publicKey: string;
}

export interface UserServerToClientEvents {
  'user:registered': (payload: {
    user: PublicUser;
    sessionToken: string;
    recoveryFile: string;
    recoveryToken: string;
    authMethod: AuthMethod;
  }) => void;
  'user:resumed': (payload: { user: PublicUser; authMethod: AuthMethod }) => void;
  'user:auth-failed': (payload: { mode: 'register' | 'resume'; reason: 'invalid' | 'temporary'; message: string }) => void;
  'user:online': (payload: { userId: string; nickname: string; avatar: number }) => void;
  'user:offline': (payload: {
    userId: string;
    user: { id: string; status: UserStatus; lastSeen: string };
  }) => void;
  'user:profile-updated': (payload: { userId: string; nickname: string; avatar: number; statusText: string | null }) => void;
  'user:profile-updated-success': (payload: { user: PublicUser; recoveryFile: string | null; recoveryToken: string | null }) => void;
  'user:password-changed': (payload: { recoveryFile: string; recoveryToken: string }) => void;
  'user:recovery-file-regenerated': (payload: { recoveryFile: string; recoveryToken: string }) => void;
  'user:sessions': (payload: { sessions: SessionSummary[] }) => void;
  'user:session-revoked': () => void;
  'user:chat-settings-updated': (payload: { chatSettings: UserChatSettings }) => void;
  'e2e:public-keys': (payload: { keys: E2ePublicKeyEntry[] }) => void;
  'e2e:my-keys': (payload: {
    publicKey: string | null;
    encryptedPrivateKeyByPassword: string | null;
    encryptedPrivateKeyByRecovery: string | null;
  }) => void;
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
  'user:update-chat-settings': (payload: UserChatSettings) => void;
  'user:logout': () => void;
  'user:visibility': (payload: { visible: boolean }, ack?: () => void) => void;
  'user:change-password': (payload: { currentPassword?: string; newPassword: string }) => void;
  'user:regenerate-recovery-file': () => void;
  'user:list-sessions': () => void;
  'user:revoke-session': (payload: { sessionId: string }) => void;
  'e2e:publish-keys': (payload: {
    publicKey?: string;
    encryptedPrivateKeyByPassword?: string;
    encryptedPrivateKeyByRecovery?: string;
  }) => void;
  'e2e:get-public-keys': (payload: { userIds: string[] }) => void;
  'e2e:get-my-keys': () => void;
}
