export const GIF_LOCALES = ['br', 'us'] as const;

export type GifLocale = (typeof GIF_LOCALES)[number];

export interface GifItem {
  id: string;
  title: string;
  url: string;
  width: number;
  height: number;
  size: number;
}

export interface GifPage {
  items: GifItem[];
  page: number;
  hasNext: boolean;
}

export interface GifMedia {
  contentType: 'image/webp' | 'image/gif';
  body: Buffer;
}

export interface GifProvider {
  trending(page: number, locale?: GifLocale): Promise<GifPage>;
  search(q: string, page: number, locale?: GifLocale): Promise<GifPage>;
  fetchMedia(url: string): Promise<GifMedia>;
}

export class GifProviderError extends Error {
  constructor() {
    super('GIF provider request failed');
    this.name = 'GifProviderError';
  }
}
