import type { ErrorPayload } from '../../lib/app-error.js';
import type { Locale } from '../../lib/locale.js';
import type { AuthMethod, AuthVersion, PublicUser, SessionSummary, UserChatSettings, UserStatus, UserTheme } from './user.model.js';

export interface E2ePublicKeyEntry {
  userId: string;
  publicKey: string;
  signingPublicKey?: string;
  keySignature?: string;
}

export interface UserServerToClientEvents {
  'user:registered': (payload: {
    user: PublicUser;
    sessionToken: string;
    authMethod: AuthMethod;
  }) => void;
  'user:resumed': (payload: { user: PublicUser; authMethod: AuthMethod }) => void;
  'user:auth-failed': (payload: { mode: 'register' | 'resume'; reason: 'invalid' | 'temporary' } & ErrorPayload) => void;
  'user:online': (payload: { userId: string; nickname: string; avatar: number }) => void;
  'user:offline': (payload: {
    userId: string;
    user: { id: string; status: UserStatus; lastSeen: string };
  }) => void;
  'user:profile-updated': (payload: { userId: string; nickname: string; avatar: number; statusText: string | null }) => void;
  'user:profile-updated-success': (payload: { user: PublicUser }) => void;
  'user:password-changed': (payload: Record<string, never>) => void;
  'user:recovery-file-regenerated': (payload: Record<string, never>) => void;
  'user:sessions': (payload: { sessions: SessionSummary[] }) => void;
  'user:session-revoked': () => void;
  'user:chat-settings-updated': (payload: { chatSettings: UserChatSettings }) => void;
  'e2e:public-keys': (payload: { keys: E2ePublicKeyEntry[] }) => void;
  'e2e:my-keys': (payload: {
    publicKey: string | null;
    encryptedPrivateKeyByPassword: string | null;
    encryptedPrivateKeyByRecovery: string | null;
    signingPublicKey: string | null;
    keySignature: string | null;
    authVersion: AuthVersion;
  }) => void;
  error: (payload: ErrorPayload & { clientTempId?: string | undefined; event?: string | undefined }) => void;
}

export interface UserClientToServerEvents {
  'user:join': (
    payload:
      | { mode: 'register'; nickname: string; avatar: number; password: string; authSalt: string; recoveryVerifier: string }
      | { mode: 'resume'; userId: string; sessionToken: string },
  ) => void;
  'user:update-profile': (payload: { nickname: string; avatar: number; currentPassword?: string }) => void;
  'user:update-status-text': (payload: { statusText: string }) => void;
  'user:update-theme': (payload: UserTheme) => void;
  'user:update-chat-settings': (payload: UserChatSettings) => void;
  'user:logout': () => void;
  'user:visibility': (payload: { visible: boolean }, ack?: () => void) => void;
  'user:change-password': (payload: {
    currentPassword?: string;
    newPassword: string;
    newAuthSalt: string;
    encryptedPrivateKeyByPassword: string;
    recoveryVerifier?: string;
    encryptedPrivateKeyByRecovery?: string;
  }) => void;
  'user:regenerate-recovery-file': (payload: {
    currentPassword?: string;
    recoveryVerifier: string;
    encryptedPrivateKeyByRecovery: string;
  }) => void;
  'user:list-sessions': () => void;
  'user:revoke-session': (payload: { sessionId: string }) => void;
  'e2e:publish-keys': (payload: {
    publicKey?: string;
    signingPublicKey?: string;
    keySignature?: string;
    encryptedPrivateKeyByPassword?: string;
    encryptedPrivateKeyByRecovery?: string;
  }) => void;
  'e2e:publish-signing-key': (payload: { signingPublicKey: string; keySignature: string }) => void;
  'e2e:get-public-keys': (payload: { userIds: string[] }) => void;
  'e2e:get-my-keys': () => void;
  'user:set-locale': (payload: { locale: Locale }) => void;
}
