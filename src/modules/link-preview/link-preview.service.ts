import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { fitLinkPreviewForEncryption } from './link-preview.limits.js';
import type { LinkPreviewRepository } from './link-preview.repository.js';
import type { LinkPreviewCacheRecord, LinkPreviewFetcher, LinkPreviewMetadata } from './link-preview.types.js';

const OK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 10 * 60 * 1000;
const CACHE_KEY_CONTEXT = 'sparkchat:link-preview-cache:v1';
const ENTRY_KEY_LABEL = 'entry-encryption';
export const SEALED_PREVIEW_PREFIX = 'sealed:v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

interface CachedFields {
  title: string;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

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

  private entryKeyFor(userId: string, url: string): Buffer {
    return createHmac('sha256', this.cacheSecret).update(ENTRY_KEY_LABEL).update('\n').update(userId).update('\n').update(url).digest();
  }

  private seal(fields: CachedFields, key: Buffer): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(fields), 'utf8'), cipher.final()]);
    return SEALED_PREVIEW_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }

  private open(record: LinkPreviewCacheRecord, key: Buffer): CachedFields | null {
    if (!record.title?.startsWith(SEALED_PREVIEW_PREFIX)) {
      return null;
    }
    try {
      const sealed = Buffer.from(record.title.slice(SEALED_PREVIEW_PREFIX.length), 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV_BYTES));
      decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const plaintext = Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
      const fields = JSON.parse(plaintext.toString('utf8')) as CachedFields;
      return typeof fields.title === 'string' ? fields : null;
    } catch {
      return null;
    }
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
    const entryKey = this.entryKeyFor(userId, url);
    const cached = await this.repository.findByKey(cacheKey);
    const cachedFields = cached && isFresh(cached, this.now()) ? this.open(cached, entryKey) : null;
    if (cachedFields) {
      return fitLinkPreviewForEncryption({ url, ...cachedFields });
    }

    const fetched = await this.fetcher.fetchMetadata(url).catch(() => null);
    const metadata = fetched ? fitLinkPreviewForEncryption({ ...fetched, url }) : null;
    if (!metadata) {
      return null;
    }

    await this.repository.upsert({
      cacheKey,
      status: 'ok',
      title: this.seal(
        { title: metadata.title, description: metadata.description, imageUrl: metadata.imageUrl, siteName: metadata.siteName },
        entryKey,
      ),
      description: null,
      imageUrl: null,
      siteName: null,
      fetchedAt: new Date(this.now()).toISOString(),
    });

    return metadata;
  }
}
