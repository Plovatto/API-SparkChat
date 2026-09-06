import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../database/turso-client.js';
import { roomKeys, roomParticipants } from '../../database/schema.js';

export interface SealedRoomKey {
  roomId: string;
  sealedKey: string;
}

export class RoomKeyRepository {
  constructor(private readonly db: Database) {}

  async publish(roomId: string, userId: string, sealedKey: string): Promise<void> {
    await this.db
      .insert(roomKeys)
      .values({ roomId, userId, sealedKey, createdAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: [roomKeys.roomId, roomKeys.userId], set: { sealedKey } });
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
      .where(and(eq(roomKeys.userId, userId), inArray(roomKeys.roomId, roomIds)));

    const byRoomId = new Map(rows.map((row) => [row.roomId, row]));
    return roomIds.map((roomId) => byRoomId.get(roomId)).filter((row): row is SealedRoomKey => row !== undefined);
  }
}
