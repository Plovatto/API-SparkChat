import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { rooms } from '@/database/schema.js';
import type { Database } from '@/database/turso-client.js';
import type { RoomService } from '@/modules/rooms/index.js';
import { fakeInvite, type FakeInvite } from './room-keys.js';

export function fakeProof(userId: string): string {
  return createHash('sha256').update(`proof:${userId}`).digest('base64url');
}

export async function seedInvite(db: Database, roomId: string, seed: string = roomId): Promise<FakeInvite> {
  const invite = fakeInvite(seed);
  await db.update(rooms).set({ inviteTokenHash: invite.tokenHash }).where(eq(rooms.id, roomId));
  return invite;
}

export async function joinGroupWithSeededInvite(db: Database, roomService: RoomService, roomId: string, userId: string) {
  const { inviteToken } = await seedInvite(db, roomId);
  return roomService.joinByInvite({ roomId, inviteToken, proof: fakeProof(userId) }, userId);
}
