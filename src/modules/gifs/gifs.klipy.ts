import { z } from 'zod';
import { discardBody, pinnedTransport, readBodyBuffer, withDeadline, type LinkPreviewTransport } from '../link-preview/link-preview.http.js';
import { fetchGifMedia, type GifMediaFetchOptions } from './gifs.media.js';
import { isAllowedGifMediaUrl } from './gifs.media-url.js';
import { GifProviderError, type GifItem, type GifLocale, type GifMedia, type GifPage, type GifProvider } from './gifs.provider.js';

const KLIPY_API_BASE_URL = 'https://api.klipy.com/api/v1';
const KLIPY_PER_PAGE = 24;
const KLIPY_TIMEOUT_MS = 8000;
const KLIPY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_LENGTH = 200;

const mediaVariantSchema = z.object({
  url: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  size: z.number().int().nonnegative(),
});

const smallFormatsSchema = z.object({
  webp: mediaVariantSchema.optional().catch(undefined),
  gif: mediaVariantSchema.optional().catch(undefined),
});

const itemSchema = z.object({
  id: z.union([z.number().int(), z.string().min(1).max(100)]),
  title: z.string().nullish(),
  type: z.string().nullish(),
  file: z.object({ sm: smallFormatsSchema }),
});

const responseSchema = z.object({
  result: z.literal(true),
  data: z.object({
    data: z.array(z.unknown()),
    current_page: z.number().int().positive(),
    has_next: z.boolean(),
  }),
});

type KlipyVariant = z.infer<typeof mediaVariantSchema>;

export interface KlipyProviderOptions extends GifMediaFetchOptions {
  apiTransport?: LinkPreviewTransport;
  apiTimeoutMs?: number;
}

function pickVariant(formats: z.infer<typeof smallFormatsSchema>): KlipyVariant | null {
  for (const candidate of [formats.webp, formats.gif]) {
    if (candidate && isAllowedGifMediaUrl(candidate.url)) {
      return candidate;
    }
  }
  return null;
}

export function normalizeKlipyItem(raw: unknown): GifItem | null {
  const parsed = itemSchema.safeParse(raw);
  if (!parsed.success || parsed.data.type === 'ad') {
    return null;
  }

  const variant = pickVariant(parsed.data.file.sm);
  if (!variant) {
    return null;
  }

  return {
    id: String(parsed.data.id),
    title: (parsed.data.title ?? '').slice(0, MAX_TITLE_LENGTH),
    url: variant.url,
    width: variant.width,
    height: variant.height,
    size: variant.size,
  };
}

export class KlipyGifProvider implements GifProvider {
  private readonly apiTransport: LinkPreviewTransport;
  private readonly apiTimeoutMs: number;

  constructor(
    private readonly apiKey: string,
    private readonly options: KlipyProviderOptions = {},
  ) {
    this.apiTransport = options.apiTransport ?? pinnedTransport;
    this.apiTimeoutMs = options.apiTimeoutMs ?? KLIPY_TIMEOUT_MS;
  }

  trending(page: number, locale?: GifLocale): Promise<GifPage> {
    return this.request('trending', page, locale);
  }

  search(q: string, page: number, locale?: GifLocale): Promise<GifPage> {
    return this.request('search', page, locale, q);
  }

  fetchMedia(url: string): Promise<GifMedia> {
    return fetchGifMedia(url, this.options);
  }

  private buildUrl(endpoint: 'trending' | 'search', page: number, locale?: GifLocale, q?: string): URL {
    const url = new URL(`${KLIPY_API_BASE_URL}/${encodeURIComponent(this.apiKey)}/gifs/${endpoint}`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(KLIPY_PER_PAGE));
    if (q !== undefined) {
      url.searchParams.set('q', q);
    }
    if (locale) {
      url.searchParams.set('locale', locale);
    }
    url.searchParams.set('content_filter', 'high');
    url.searchParams.set('format_filter', 'webp,gif');
    return url;
  }

  private async request(endpoint: 'trending' | 'search', page: number, locale?: GifLocale, q?: string): Promise<GifPage> {
    try {
      const url = this.buildUrl(endpoint, page, locale, q);
      const body = await withDeadline(this.apiTimeoutMs, async (signal) => {
        const response = await this.apiTransport(url, { signal, accept: 'application/json' });
        if (response.status !== 200) {
          await discardBody(response);
          return null;
        }
        return readBodyBuffer(response, KLIPY_MAX_RESPONSE_BYTES, false, signal);
      });
      if (!body) {
        throw new GifProviderError();
      }

      const parsed = responseSchema.parse(JSON.parse(body.toString('utf8')));
      const items = parsed.data.data.map(normalizeKlipyItem).filter((item): item is GifItem => item !== null);
      return { items, page: parsed.data.current_page, hasNext: parsed.data.has_next };
    } catch {
      throw new GifProviderError();
    }
  }
}
