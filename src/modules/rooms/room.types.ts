import type { MessageView } from '../messages/index.js';
import type { UserStatus } from '../users/index.js';
import type { RoomInviteView } from './room.invites.js';

export type RoomType = 'private' | 'group';

export const MAX_GROUP_MEMBERS = 150;

export interface RoomRecord {
  id: string;
  type: RoomType;
  name?: string | undefined;
  roomCode?: string | undefined;
  participants: string[];
  admins: string[];
  createdBy?: string | undefined;
  createdAt: string;
  visibleTo: string[];
  blockedBy: Record<string, string>;
  deletedAt: Record<string, string>;
  reactivatedAt?: Record<string, string> | undefined;
  joinedAt?: Record<string, string> | undefined;
  currentEpoch?: number | undefined;
  currentKeyId?: string | undefined;
  rotationRequired?: number | undefined;
  inviteTokenHash?: string | undefined;
  encryptedInvite?: string | undefined;
  inviteKeyId?: string | undefined;
}

export interface RoomParticipant {
  id: string;
  nickname: string;
  avatar: number;
  status: UserStatus;
  statusText: string | null;
  lastSeen: string;
  isAdmin: boolean;
}

export interface RoomSummary {
  id: string;
  type: RoomType;
  name?: string | undefined;
  createdBy?: string | undefined;
  creatorId?: string | undefined;
  participants: RoomParticipant[];
  lastMessage: MessageView | null;
  unreadCount: number;
  mentionCount: number;
  blockedBy: Record<string, string>;
  isBlockedBy: boolean;
  userBlocked: boolean;
  isMutuallyBlocked: boolean;
  currentEpoch: number;
  currentKeyId: string | null;
  rotationRequiredEpoch: number | null;
  invite: RoomInviteView | null;
}
