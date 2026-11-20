import type { MessageView } from '../messages/index.js';
import type { UserStatus } from '../users/index.js';
import type { InviteProofView, RoomInviteView, RoomNameView, RoomRosterView } from './room.invites.js';

export type RoomType = 'private' | 'group';

export const MAX_GROUP_MEMBERS = 150;

export interface RoomRecord {
  id: string;
  type: RoomType;
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
  encryptedRoster?: string | undefined;
  rosterKeyId?: string | undefined;
  encryptedName?: string | undefined;
  nameKeyId?: string | undefined;
  inviteProofs?: Record<string, string> | undefined;
  encryptedAvatar?: string | undefined;
  avatarKeyId?: string | undefined;
  profileKeyEnvelopes?: Record<string, ProfileKeyEnvelopeView> | undefined;
}

export interface ProfileKeyEnvelopeView {
  envelope: string;
  keyId: string;
}

export interface RoomAvatarView {
  encryptedAvatar: string;
  keyId: string;
}

export interface RoomParticipant {
  id: string;
  nickname: string;
  avatar: number;
  status: UserStatus;
  statusText: string | null;
  lastSeen: string;
  isAdmin: boolean;
  encryptedAvatar: string | null;
  profileKeyVersion: number;
  profileKeyEnvelope: ProfileKeyEnvelopeView | null;
}

export interface RoomSummary {
  id: string;
  type: RoomType;
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
  roster: RoomRosterView | null;
  encryptedName: RoomNameView | null;
  encryptedAvatar: RoomAvatarView | null;
  inviteProofs: InviteProofView[];
}
