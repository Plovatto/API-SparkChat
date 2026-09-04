import type { LinkPreviewRepository } from './link-preview.repository.js';
import type { LinkPreviewCacheRecord, LinkPreviewFetcher, LinkPreviewMetadata } from './link-preview.types.js';

const OK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ERROR_TTL_MS = 60 * 60 * 1000;

function isFresh(record: LinkPreviewCacheRecord): boolean {
  const ttl = record.status === 'ok' ? OK_TTL_MS : ERROR_TTL_MS;
  return Date.now() - new Date(record.fetchedAt).getTime() < ttl;
}

function toMetadata(record: LinkPreviewCacheRecord): LinkPreviewMetadata | null {
  if (record.status === 'error' || !record.title) {
    return null;
  }
  return {
    url: record.url,
    title: record.title,
    description: record.description,
    imageUrl: record.imageUrl,
    siteName: record.siteName,
  };
}

export class LinkPreviewService {
  constructor(
    private readonly repository: LinkPreviewRepository,
    private readonly fetcher: LinkPreviewFetcher,
  ) {}

  async getPreview(url: string): Promise<LinkPreviewMetadata | null> {
    const cached = await this.repository.findByUrl(url);
    if (cached && isFresh(cached)) {
      return toMetadata(cached);
    }

    const metadata = await this.fetcher.fetchMetadata(url).catch(() => null);
    const fetchedAt = new Date().toISOString();

    if (!metadata) {
      await this.repository.upsert({
        url,
        status: 'error',
        title: null,
        description: null,
        imageUrl: null,
        siteName: null,
        fetchedAt,
      });
      return null;
    }

    await this.repository.upsert({
      url,
      status: 'ok',
      title: metadata.title,
      description: metadata.description,
      imageUrl: metadata.imageUrl,
      siteName: metadata.siteName,
      fetchedAt,
    });

    return metadata;
  }
}
