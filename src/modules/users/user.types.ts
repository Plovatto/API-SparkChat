import type { UserStatus, UserTheme } from './user.model.js';

export interface UserRecord {
  id: string;
  nickname: string;
  avatar: number;
  chatCode: string;
  loginCode: string;
  socketId: string;
  status: UserStatus;
  createdAt: string;
  lastSeen: string;
  theme?: UserTheme;
}
