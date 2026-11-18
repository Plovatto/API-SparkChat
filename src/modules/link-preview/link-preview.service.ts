import { createHmac } from 'node:crypto';
import { fitLinkPreviewForEncryption } from './link-preview.limits.js';
import type { LinkPreviewRepository } from './link-preview.repository.js';
import type { LinkPreviewCacheRecord, LinkPreviewFetcher, LinkPreviewMetadata } from './link-preview.types.js';

const OK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 10 * 60 * 1000;
const CACHE_KEY_CONTEXT = 'sparkchat:link-preview-cache:v1';

function isFresh(record: LinkPreviewCacheRecord, now: number): boolean {
  return record.status === 'ok' && now - new Date(record.fetchedAt).getTime() < OK_TTL_MS;
}

function hasUserinfo(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    return true;
  }
}

function toMetadata(record: LinkPreviewCacheRecord, url: string): LinkPreviewMetadata | null {
  if (!record.title) {
    return null;
  }
  return fitLinkPreviewForEncryption({
    url,
    title: record.title,
    description: record.description,
    imageUrl: record.imageUrl,
    siteName: record.siteName,
  });
}

export class LinkPreviewService {
  private readonly cacheSecret: Buffer;
  private lastPurgeAt = 0;

  constructor(
    private readonly repository: LinkPreviewRepository,
    private readonly fetcher: LinkPreviewFetcher,
    secret: string,
    private readonly now: () => number = Date.now,
  ) {
    this.cacheSecret = createHmac('sha256', secret).update(CACHE_KEY_CONTEXT).digest();
  }

  cacheKeyFor(userId: string, url: string): string {
    return createHmac('sha256', this.cacheSecret).update(userId).update('\n').update(url).digest('hex');
  }

  async purgeExpired(): Promise<void> {
    const now = this.now();
    this.lastPurgeAt = now;
    await this.repository.purge(new Date(now - OK_TTL_MS).toISOString());
  }

  async getPreview(userId: string, url: string): Promise<LinkPreviewMetadata | null> {
    if (hasUserinfo(url)) {
      return null;
    }

    if (this.now() - this.lastPurgeAt >= PURGE_INTERVAL_MS) {
      await this.purgeExpired().catch(() => undefined);
    }

    const cacheKey = this.cacheKeyFor(userId, url);
    const cached = await this.repository.findByKey(cacheKey);
    if (cached && isFresh(cached, this.now())) {
      return toMetadata(cached, url);
    }

    const fetched = await this.fetcher.fetchMetadata(url).catch(() => null);
    const metadata = fetched ? fitLinkPreviewForEncryption({ ...fetched, url }) : null;
    if (!metadata) {
      return null;
    }

    await this.repository.upsert({
      cacheKey,
      status: 'ok',
      title: metadata.title,
      description: metadata.description,
      imageUrl: metadata.imageUrl,
      siteName: metadata.siteName,
      fetchedAt: new Date(this.now()).toISOString(),
    });

    return metadata;
  }
}
