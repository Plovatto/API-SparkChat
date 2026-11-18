import { eq, like, lt, ne, or } from 'drizzle-orm';
import type { Database } from '../../database/turso-client.js';
import { linkPreviews } from '../../database/schema.js';
import type { LinkPreviewCacheRecord } from './link-preview.types.js';

export class LinkPreviewRepository {
  constructor(private readonly db: Database) {}

  async findByKey(cacheKey: string): Promise<LinkPreviewCacheRecord | null> {
    const [row] = await this.db.select().from(linkPreviews).where(eq(linkPreviews.cacheKey, cacheKey));
    return row ?? null;
  }

  async upsert(record: LinkPreviewCacheRecord): Promise<void> {
    await this.db
      .insert(linkPreviews)
      .values(record)
      .onConflictDoUpdate({ target: linkPreviews.cacheKey, set: record });
  }

  async purge(fetchedBefore: string): Promise<void> {
    await this.db
      .delete(linkPreviews)
      .where(or(ne(linkPreviews.status, 'ok'), lt(linkPreviews.fetchedAt, fetchedBefore), like(linkPreviews.cacheKey, '%:%')));
  }
}
