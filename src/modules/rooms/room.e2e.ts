import { and, eq } from 'drizzle-orm';
import type { Database } from '../../database/turso-client.js';
import { roomKeys } from '../../database/schema.js';

export interface RoomKeyEntry {
  userId: string;
  sealedKey: string;
}

export class RoomKeyRepository {
  constructor(private readonly db: Database) {}

  async publish(roomId: string, userId: string, sealedKey: string): Promise<void> {
    const [existing] = await this.db
      .select()
      .from(roomKeys)
      .where(and(eq(roomKeys.roomId, roomId), eq(roomKeys.userId, userId)));

    if (existing) {
      await this.db
        .update(roomKeys)
        .set({ sealedKey })
        .where(and(eq(roomKeys.roomId, roomId), eq(roomKeys.userId, userId)));
      return;
    }

    await this.db.insert(roomKeys).values({ roomId, userId, sealedKey, createdAt: new Date().toISOString() });
  }

  async findForUser(roomId: string, userId: string): Promise<string | null> {
    const [row] = await this.db
      .select()
      .from(roomKeys)
      .where(and(eq(roomKeys.roomId, roomId), eq(roomKeys.userId, userId)));

    return row?.sealedKey ?? null;
  }
}
