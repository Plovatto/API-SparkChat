import type { AuthMethod, AuthVersion, UserChatSettings, UserStatus, UserTheme } from './user.model.js';

export interface UserRecord {
  id: string;
  nickname: string;
  nicknameNormalized: string;
  avatar: number;
  passwordHash: string;
  recoveryTokenHash: string;
  status: UserStatus;
  statusText: string | null;
  createdAt: string;
  lastSeen: string;
  theme?: UserTheme;
  chatSettings?: UserChatSettings | null;
  e2ePublicKey?: string | null;
  e2eSigningPublicKey?: string | null;
  e2eKeySignature?: string | null;
  e2eEncryptedPrivateKeyByPassword?: string | null;
  e2eEncryptedPrivateKeyByRecovery?: string | null;
  authSalt?: string | null;
  authVersion?: AuthVersion;
  encryptedAvatar?: string | null;
  profileKeyVersion?: number;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  authMethod: AuthMethod;
  userAgent: string;
  createdAt: string;
  lastUsedAt: string;
  devicePublicKey: string | null;
}
