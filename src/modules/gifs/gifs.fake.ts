import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { GifProviderError, type GifItem, type GifLocale, type GifMedia, type GifPage, type GifProvider } from './gifs.provider.js';

export const FAKE_GIF_EMPTY_QUERY = 'zzz-empty';
export const FAKE_GIF_ERROR_QUERY = 'zzz-error';

const FAKE_MEDIA_URL_PATTERN = /^https:\/\/static\.klipy\.com\/ii\/sparkchatfake\/v(\d)\/p\d{1,3}\/fake-([a-f0-9]{12})\.webp$/;

interface FakeVariantSpec {
  width: number;
  height: number;
  frames: number;
  noisy: boolean;
}

const FAKE_VARIANTS: FakeVariantSpec[] = [
  { width: 160, height: 120, frames: 4, noisy: false },
  { width: 120, height: 160, frames: 3, noisy: false },
  { width: 200, height: 112, frames: 5, noisy: false },
  { width: 140, height: 140, frames: 4, noisy: false },
  { width: 220, height: 160, frames: 3, noisy: true },
  { width: 300, height: 260, frames: 3, noisy: true },
];

export interface FakeGifProviderOptions {
  pageSize?: number;
  trendingPages?: number;
  searchPages?: number;
}

interface FakeVariant {
  width: number;
  height: number;
  body: Buffer;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function seededBytes(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let state = Number.parseInt(digest(seed).slice(0, 8), 16) || 1;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[index] = state & 0xff;
  }
  return out;
}

async function renderVariant(index: number, spec: FakeVariantSpec): Promise<FakeVariant> {
  const frames = await Promise.all(
    Array.from({ length: spec.frames }, (_, frame) => {
      const raw = spec.noisy
        ? seededBytes(`variant-${index}-frame-${frame}`, spec.width * spec.height * 3)
        : Buffer.alloc(spec.width * spec.height * 3, (index * 40 + frame * 60) % 256);
      return sharp(raw, { raw: { width: spec.width, height: spec.height, channels: 3 } }).png().toBuffer();
    }),
  );
  const body = await sharp(frames, { join: { animated: true } })
    .webp({ loop: 0, delay: 150, lossless: spec.noisy })
    .toBuffer();
  return { width: spec.width, height: spec.height, body };
}

export class FakeGifProvider implements GifProvider {
  private variants: Promise<FakeVariant[]> | null = null;
  private readonly pageSize: number;
  private readonly trendingPages: number;
  private readonly searchPages: number;

  constructor(options: FakeGifProviderOptions = {}) {
    this.pageSize = options.pageSize ?? 24;
    this.trendingPages = options.trendingPages ?? 3;
    this.searchPages = options.searchPages ?? 2;
  }

  trending(page: number, locale?: GifLocale): Promise<GifPage> {
    return this.buildPage(`trending:${locale ?? ''}`, 'Trending', page, this.trendingPages);
  }

  search(q: string, page: number, locale?: GifLocale): Promise<GifPage> {
    if (q === FAKE_GIF_ERROR_QUERY) {
      return Promise.reject(new GifProviderError());
    }
    if (q === FAKE_GIF_EMPTY_QUERY) {
      return Promise.resolve({ items: [], page, hasNext: false });
    }
    return this.buildPage(`search:${locale ?? ''}:${q}`, q, page, this.searchPages);
  }

  async fetchMedia(url: string): Promise<GifMedia> {
    const match = FAKE_MEDIA_URL_PATTERN.exec(url);
    const variant = match ? (await this.loadVariants())[Number(match[1])] : undefined;
    if (!variant) {
      throw new GifProviderError();
    }
    return { contentType: 'image/webp', body: variant.body };
  }

  private loadVariants(): Promise<FakeVariant[]> {
    this.variants ??= Promise.all(FAKE_VARIANTS.map((spec, index) => renderVariant(index, spec)));
    return this.variants;
  }

  private async buildPage(seed: string, label: string, page: number, totalPages: number): Promise<GifPage> {
    if (page > totalPages) {
      return { items: [], page, hasNext: false };
    }

    const variants = await this.loadVariants();
    const items: GifItem[] = Array.from({ length: this.pageSize }, (_, index) => {
      const id = digest(`${seed}:${page}:${index}`).slice(0, 12);
      const variantIndex = Number.parseInt(id.slice(0, 4), 16) % variants.length;
      const variant = variants[variantIndex] as FakeVariant;
      return {
        id,
        title: `${label} ${page}-${index + 1}`,
        url: `https://static.klipy.com/ii/sparkchatfake/v${variantIndex}/p${page}/fake-${id}.webp`,
        width: variant.width,
        height: variant.height,
        size: variant.body.length,
      };
    });
    return { items, page, hasNext: page < totalPages };
  }
}
