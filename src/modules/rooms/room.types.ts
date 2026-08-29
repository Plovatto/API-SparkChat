import type { MessageView } from '../messages/index.js';
import type { UserStatus } from '../users/index.js';

export type RoomType = 'private' | 'group';

export interface RoomRecord {
  id: string;
  type: RoomType;
  name?: string | undefined;
  roomCode?: string | undefined;
  participants: string[];
  createdBy?: string | undefined;
  createdAt: string;
  visibleTo: string[];
  blockedBy: Record<string, string>;
  deletedAt: Record<string, string>;
  reactivatedAt?: Record<string, string> | undefined;
  joinedAt?: Record<string, string> | undefined;
}

export interface RoomParticipant {
  id: string;
  nickname: string;
  avatar: number;
  status: UserStatus;
  chatCode: string;
  lastSeen: string;
}

export interface RoomSummary {
  id: string;
  type: RoomType;
  name?: string | undefined;
  roomCode?: string | undefined;
  createdBy?: string | undefined;
  creatorId?: string | undefined;
  participants: RoomParticipant[];
  lastMessage: MessageView | null;
  unreadCount: number;
  blockedBy: Record<string, string>;
  isBlockedBy: boolean;
  userBlocked: boolean;
  isMutuallyBlocked: boolean;
}
