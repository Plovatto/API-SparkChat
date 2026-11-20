import { and, eq, sql } from 'drizzle-orm';
import { storageUsage } from '../database/schema.js';
import type { Database } from '../database/turso-client.js';

const GLOBAL_ROW_ID = 'global';

export class StorageUsageRepository {
  constructor(private readonly db: Database) {}

  async getBytesUsed(): Promise<number> {
    const [row] = await this.db.select().from(storageUsage).where(eq(storageUsage.id, GLOBAL_ROW_ID));
    return row?.bytesUsed ?? 0;
  }

  async tryReserve(bytes: number, maxBytes: number): Promise<boolean> {
    const reserve = () =>
      this.db
        .update(storageUsage)
        .set({ bytesUsed: sql`${storageUsage.bytesUsed} + ${bytes}` })
        .where(and(eq(storageUsage.id, GLOBAL_ROW_ID), sql`${storageUsage.bytesUsed} + ${bytes} <= ${maxBytes}`))
        .returning({ id: storageUsage.id });

    if ((await reserve()).length > 0) {
      return true;
    }
    await this.db.insert(storageUsage).values({ id: GLOBAL_ROW_ID, bytesUsed: 0 }).onConflictDoNothing();
    return (await reserve()).length > 0;
  }

  async addBytes(delta: number): Promise<void> {
    await this.db
      .insert(storageUsage)
      .values({ id: GLOBAL_ROW_ID, bytesUsed: Math.max(0, delta) })
      .onConflictDoUpdate({
        target: storageUsage.id,
        set: { bytesUsed: sql`max(0, ${storageUsage.bytesUsed} + ${delta})` },
      });
  }
}
