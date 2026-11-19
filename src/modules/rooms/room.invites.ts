import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { KEY_ID_PATTERN } from './room.key-envelope.js';

export const INVITE_TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const INVITE_SECRET_VALUE_PATTERN = /^[A-Za-z0-9_\-+/]{16,128}={0,2}$/;
const MAX_ENCRYPTED_INVITE_LENGTH = 1024;

export interface RoomInvite {
  tokenHash: string;
  encryptedInvite: string;
}

export interface RoomInviteView {
  encryptedInvite: string;
  keyId: string;
}

export const inviteValueSchema = z.string().regex(INVITE_SECRET_VALUE_PATTERN);

export const roomInviteSchema = z.object({
  tokenHash: z.string().regex(INVITE_TOKEN_HASH_PATTERN),
  encryptedInvite: z.string().trim().min(1).max(MAX_ENCRYPTED_INVITE_LENGTH),
});

export const resetInvitePayloadSchema = z.object({
  roomId: z.string().trim().min(1),
  invite: roomInviteSchema.extend({ keyId: z.string().regex(KEY_ID_PATTERN) }),
});

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
