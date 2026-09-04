import type { AuthMethod, UserStatus, UserTheme } from './user.model.js';

export interface UserRecord {
  id: string;
  nickname: string;
  nicknameNormalized: string;
  avatar: number;
  passwordHash: string;
  recoveryTokenHash: string;
  socketId: string;
  status: UserStatus;
  statusText: string | null;
  createdAt: string;
  lastSeen: string;
  theme?: UserTheme;
  e2ePublicKey?: string | null;
  e2eEncryptedPrivateKeyByPassword?: string | null;
  e2eEncryptedPrivateKeyByRecovery?: string | null;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  authMethod: AuthMethod;
  userAgent: string;
  createdAt: string;
  lastUsedAt: string;
}
