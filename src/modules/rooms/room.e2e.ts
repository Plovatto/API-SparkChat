import { and, eq } from 'drizzle-orm';
import type { Database } from '../../database/turso-client.js';
import { roomKeys } from '../../database/schema.js';

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
}
