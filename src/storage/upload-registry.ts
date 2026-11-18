import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { uploads } from '../database/schema.js';
import type { Database } from '../database/turso-client.js';

export interface UploadRecord {
  key: string;
  uploaderId: string;
  size: number;
  createdAt: string;
  messageId: string | null;
}

export class UploadRegistry {
  constructor(private readonly db: Database) {}

  async register(key: string, uploaderId: string, size: number): Promise<void> {
    await this.db.insert(uploads).values({ key, uploaderId, size, createdAt: new Date().toISOString(), messageId: null });
  }

  async find(key: string): Promise<UploadRecord | null> {
    const [row] = await this.db.select().from(uploads).where(eq(uploads.key, key));
    return row ?? null;
  }

  async totalBytesFor(uploaderId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`coalesce(sum(${uploads.size}), 0)` })
      .from(uploads)
      .where(eq(uploads.uploaderId, uploaderId));
    return Number(row?.total ?? 0);
  }

  async claim(keys: string[], uploaderId: string, messageId: string): Promise<boolean> {
    if (keys.length === 0) {
      return true;
    }

    const claimed = await this.db
      .update(uploads)
      .set({ messageId })
      .where(and(inArray(uploads.key, keys), eq(uploads.uploaderId, uploaderId), isNull(uploads.messageId)))
      .returning({ key: uploads.key });

    if (claimed.length === new Set(keys).size) {
      return true;
    }

    await this.release(messageId);
    return false;
  }

  async release(messageId: string): Promise<void> {
    await this.db.update(uploads).set({ messageId: null }).where(eq(uploads.messageId, messageId));
  }

  async remove(key: string): Promise<void> {
    await this.db.delete(uploads).where(eq(uploads.key, key));
  }

  async removeIfUnattached(key: string): Promise<boolean> {
    const removed = await this.db
      .delete(uploads)
      .where(and(eq(uploads.key, key), isNull(uploads.messageId)))
      .returning({ key: uploads.key });
    return removed.length > 0;
  }

  findUnattachedBefore(cutoff: string, limit: number): Promise<UploadRecord[]> {
    return this.db
      .select()
      .from(uploads)
      .where(and(isNull(uploads.messageId), lt(uploads.createdAt, cutoff)))
      .limit(limit);
  }
}
