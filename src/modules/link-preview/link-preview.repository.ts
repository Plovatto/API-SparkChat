import { eq } from 'drizzle-orm';
import type { Database } from '../../database/turso-client.js';
import { linkPreviews } from '../../database/schema.js';
import type { LinkPreviewCacheRecord } from './link-preview.types.js';

export class LinkPreviewRepository {
  constructor(private readonly db: Database) {}

  async findByUrl(url: string): Promise<LinkPreviewCacheRecord | null> {
    const [row] = await this.db.select().from(linkPreviews).where(eq(linkPreviews.url, url));
    return row ?? null;
  }

  async upsert(record: LinkPreviewCacheRecord): Promise<void> {
    await this.db
      .insert(linkPreviews)
      .values(record)
      .onConflictDoUpdate({ target: linkPreviews.url, set: record });
  }
}
