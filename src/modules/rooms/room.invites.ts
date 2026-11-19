import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const INVITE_TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const INVITE_SECRET_VALUE_PATTERN = /^[A-Za-z0-9_\-+/]{16,128}={0,2}$/;
const MAX_ENCRYPTED_INVITE_LENGTH = 1024;
export const MAX_ENCRYPTED_ROSTER_LENGTH = 32 * 1024;
export const MAX_ENCRYPTED_NAME_LENGTH = 2 * 1024;

export interface RoomInvite {
  tokenHash: string;
  encryptedInvite: string;
}

export interface RoomInviteView {
  encryptedInvite: string;
  keyId: string;
  active: boolean;
}

export function toInviteView(room: { encryptedInvite?: string | undefined; inviteKeyId?: string | undefined; inviteTokenHash?: string | undefined }): RoomInviteView | null {
  if (!room.encryptedInvite || !room.inviteKeyId) {
    return null;
  }
  return { encryptedInvite: room.encryptedInvite, keyId: room.inviteKeyId, active: Boolean(room.inviteTokenHash) };
}

export interface RoomRosterView {
  encryptedRoster: string;
  keyId: string;
}

export interface RoomNameView {
  encryptedName: string;
  keyId: string;
}

export interface InviteProofView {
  userId: string;
  proof: string;
}

export const inviteValueSchema = z.string().regex(INVITE_SECRET_VALUE_PATTERN);

export const roomInviteSchema = z.object({
  tokenHash: z.string().regex(INVITE_TOKEN_HASH_PATTERN),
  encryptedInvite: z.string().trim().min(1).max(MAX_ENCRYPTED_INVITE_LENGTH),
});

export const encryptedRosterSchema = z.string().trim().min(1).max(MAX_ENCRYPTED_ROSTER_LENGTH);

export const encryptedNameSchema = z.string().trim().min(1).max(MAX_ENCRYPTED_NAME_LENGTH);

export const joinByInvitePayloadSchema = z.object({
  roomId: z.string().trim().min(1),
  inviteToken: inviteValueSchema,
  proof: inviteValueSchema,
});

export function hashInviteToken(inviteToken: string): string {
  return createHash('sha256').update(inviteToken, 'utf8').digest('hex');
}

export function matchesInviteToken(inviteToken: string, storedHash: string | undefined): boolean {
  if (!storedHash || !INVITE_TOKEN_HASH_PATTERN.test(storedHash)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(hashInviteToken(inviteToken), 'hex'), Buffer.from(storedHash, 'hex'));
}
