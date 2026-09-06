import { eq, sql } from 'drizzle-orm';
import { storageUsage } from '../database/schema.js';
import type { Database } from '../database/turso-client.js';

const GLOBAL_ROW_ID = 'global';

export class StorageUsageRepository {
  constructor(private readonly db: Database) {}

  async getBytesUsed(): Promise<number> {
    const [row] = await this.db.select().from(storageUsage).where(eq(storageUsage.id, GLOBAL_ROW_ID));
    return row?.bytesUsed ?? 0;
  }

  async addBytes(delta: number): Promise<void> {
    await this.db
      .insert(storageUsage)
      .values({ id: GLOBAL_ROW_ID, bytesUsed: delta })
      .onConflictDoUpdate({
        target: storageUsage.id,
        set: { bytesUsed: sql`${storageUsage.bytesUsed} + ${delta}` },
      });
  }
}
