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
  createdAt: string;
  lastSeen: string;
  theme?: UserTheme;
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
