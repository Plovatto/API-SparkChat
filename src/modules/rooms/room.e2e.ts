import { and, eq, inArray, notExists } from 'drizzle-orm';
import type { Database } from '../../database/turso-client.js';
import { roomBans, roomKeys, roomParticipants } from '../../database/schema.js';

export interface SealedRoomKey {
  roomId: string;
  sealedKey: string;
}

export interface RoomKeyWrite {
  userId: string;
  sealedKey: string;
  replaceable: boolean;
}

export interface RoomKeyBatchResult {
  rejected: boolean;
  stored: RoomKeyWrite[];
}

export class RoomKeyRepository {
  constructor(private readonly db: Database) {}

  async publish(roomId: string, userId: string, sealedKey: string): Promise<void> {
    await this.db
      .insert(roomKeys)
      .values({ roomId, userId, sealedKey, createdAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: [roomKeys.roomId, roomKeys.userId], set: { sealedKey } });
  }

  publishBatch(roomId: string, writes: RoomKeyWrite[], rejectOnConflict: boolean): Promise<RoomKeyBatchResult> {
    return this.db.transaction(async (tx) => {
      const existingRows = writes.length
        ? await tx
            .select({ userId: roomKeys.userId })
            .from(roomKeys)
            .where(and(eq(roomKeys.roomId, roomId), inArray(roomKeys.userId, writes.map((write) => write.userId))))
        : [];
      const existing = new Set(existingRows.map((row) => row.userId));
      const blocked = (write: RoomKeyWrite) => existing.has(write.userId) && !write.replaceable;

      if (rejectOnConflict && writes.some(blocked)) {
        return { rejected: true, stored: [] };
      }

      const stored = writes.filter((write) => !blocked(write));
      const createdAt = new Date().toISOString();
      for (const write of stored) {
        await tx
          .insert(roomKeys)
          .values({ roomId, userId: write.userId, sealedKey: write.sealedKey, createdAt })
          .onConflictDoUpdate({ target: [roomKeys.roomId, roomKeys.userId], set: { sealedKey: write.sealedKey } });
      }

      return { rejected: false, stored };
    });
  }

  async findForUser(roomId: string, userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ sealedKey: roomKeys.sealedKey })
      .from(roomKeys)
      .where(and(eq(roomKeys.roomId, roomId), eq(roomKeys.userId, userId)));

    return row?.sealedKey ?? null;
  }

  async findForParticipantInRooms(roomIds: string[], userId: string): Promise<SealedRoomKey[]> {
    if (roomIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .select({ roomId: roomKeys.roomId, sealedKey: roomKeys.sealedKey })
      .from(roomKeys)
      .innerJoin(roomParticipants, and(eq(roomParticipants.roomId, roomKeys.roomId), eq(roomParticipants.userId, roomKeys.userId)))
      .where(
        and(
          eq(roomKeys.userId, userId),
          inArray(roomKeys.roomId, roomIds),
          notExists(
            this.db
              .select({ userId: roomBans.userId })
              .from(roomBans)
              .where(and(eq(roomBans.roomId, roomKeys.roomId), eq(roomBans.userId, roomKeys.userId))),
          ),
        ),
      );

    const byRoomId = new Map(rows.map((row) => [row.roomId, row]));
    return roomIds.map((roomId) => byRoomId.get(roomId)).filter((row): row is SealedRoomKey => row !== undefined);
  }
}
