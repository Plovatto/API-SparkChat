import { describe, expect, it, vi } from 'vitest';
import { GifProviderError, KlipyGifProvider } from '@/modules/gifs/index.js';
import { normalizeKlipyItem } from '@/modules/gifs/gifs.klipy.js';
import type { LinkPreviewTransport } from '@/modules/link-preview/link-preview.http.js';

const API_KEY = 'secret-klipy-key-123';
const MEDIA = 'https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/eUbp2uNc';

function variant(url: string, size = 1000) {
  return { url, width: 220, height: 160, size };
}

function item(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    slug: `slug-${id}`,
    title: `Title ${id}`,
    type: 'gif',
    tags: [],
    blur_preview: 'data:image/jpeg;base64,xx',
    file: {
      hd: { webp: variant(`${MEDIA}.webp`, 999_999) },
      sm: { webp: variant(`${MEDIA}.webp`, 117_000), gif: variant(`${MEDIA}.gif`, 300_000) },
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function page(items: unknown[], overrides: Record<string, unknown> = {}) {
  return { result: true, data: { data: items, current_page: 2, per_page: 24, has_next: true, ...overrides } };
}

function providerWith(respond: () => Promise<Response>) {
  const apiTransport = vi.fn<LinkPreviewTransport>(() => respond());
  return { provider: new KlipyGifProvider(API_KEY, { apiTransport }), apiTransport };
}

function providerReturning(body: unknown) {
  return providerWith(() => Promise.resolve(jsonResponse(body)));
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

describe('KlipyGifProvider requests', () => {
  it('asks trending with the safe filters, the page, the locale and no customer id', async () => {
    const { provider, apiTransport } = providerReturning(page([]));

    await provider.trending(2, 'br');

    const url = apiTransport.mock.calls[0]?.[0] as URL;
    expect(`${url.origin}${url.pathname}`).toBe(`https://api.klipy.com/api/v1/${API_KEY}/gifs/trending`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: '2',
      per_page: '24',
      locale: 'br',
      content_filter: 'high',
      format_filter: 'webp,gif',
    });
    expect(url.searchParams.has('customer_id')).toBe(false);
  });

  it('sends the search term and omits the locale when none is given', async () => {
    const { provider, apiTransport } = providerReturning(page([]));

    await provider.search('gato feliz', 1);

    const url = apiTransport.mock.calls[0]?.[0] as URL;
    expect(url.pathname).toBe(`/api/v1/${API_KEY}/gifs/search`);
    expect(url.searchParams.get('q')).toBe('gato feliz');
    expect(url.searchParams.has('locale')).toBe(false);
    expect(url.searchParams.has('customer_id')).toBe(false);
    expect(url.searchParams.get('content_filter')).toBe('high');
    expect(url.searchParams.get('format_filter')).toBe('webp,gif');
  });
});

describe('KlipyGifProvider normalization', () => {
  it('maps items to the small webp rendition and keeps the paging info', async () => {
    const { provider } = providerReturning(page([item(42)]));

    await expect(provider.trending(2)).resolves.toEqual({
      items: [{ id: '42', title: 'Title 42', url: `${MEDIA}.webp`, width: 220, height: 160, size: 117_000 }],
      page: 2,
      hasNext: true,
    });
  });

  it('falls back to the small gif when the webp is missing and drops items without either', () => {
    expect(normalizeKlipyItem(item(1, { file: { sm: { gif: variant(`${MEDIA}.gif`, 5) } } }))).toMatchObject({ url: `${MEDIA}.gif`, size: 5 });
    expect(normalizeKlipyItem(item(2, { file: { sm: { mp4: variant(`${MEDIA}.mp4`) } } }))).toBeNull();
    expect(normalizeKlipyItem(item(3, { file: { hd: { webp: variant(`${MEDIA}.webp`) } } }))).toBeNull();
  });

  it('drops ads, malformed items and items whose media URL is not allowed', async () => {
    const { provider } = providerReturning(
      page([
        item(1, { type: 'ad' }),
        item(2, { file: { sm: { webp: variant('https://evil.test/ii/935d7ab9d8c6202580a668421940ec81/14/af/eUbp2uNc.webp') } } }),
        item(3, { file: { sm: { webp: variant(`${MEDIA}.webp?x=1`) } } }),
        { nope: true },
        'garbage',
        item(4),
      ]),
    );

    const result = await provider.trending(1);

    expect(result.items.map((entry) => entry.id)).toEqual(['4']);
  });

  it('uses the gif rendition when the webp URL is not allowed', () => {
    const raw = item(5, { file: { sm: { webp: variant('https://evil.test/a.webp'), gif: variant(`${MEDIA}.gif`) } } });

    expect(normalizeKlipyItem(raw)?.url).toBe(`${MEDIA}.gif`);
  });

  it('tolerates a missing title', () => {
    expect(normalizeKlipyItem(item(6, { title: undefined }))?.title).toBe('');
  });
});

describe('KlipyGifProvider failures', () => {
  it.each([
    ['a non-200 status', () => Promise.resolve(jsonResponse({ result: false }, 401))],
    ['a redirect', () => Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.test' } }))],
    ['result false', () => Promise.resolve(jsonResponse({ result: false, data: { data: [], current_page: 1, has_next: false } }))],
    ['invalid JSON', () => Promise.resolve(new Response('<html>', { status: 200 }))],
    ['an unexpected shape', () => Promise.resolve(jsonResponse({ result: true, data: [] }))],
    ['a transport error carrying the URL', () => Promise.reject(new Error(`connect failed https://api.klipy.com/api/v1/${API_KEY}/gifs/trending`))],
  ])('rejects with a generic error that never contains the key on %s', async (_label, respond) => {
    const { provider } = providerWith(respond);

    const error = await captureError(provider.trending(1));

    expect(error).toBeInstanceOf(GifProviderError);
    expect(error.message).not.toContain(API_KEY);
    expect(String(error.stack)).not.toContain(API_KEY);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    expect(error.cause).toBeUndefined();
  });

  it('gives up when the provider takes too long', async () => {
    const apiTransport = vi.fn<LinkPreviewTransport>(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const provider = new KlipyGifProvider(API_KEY, { apiTransport, apiTimeoutMs: 20 });

    await expect(provider.search('x', 1)).rejects.toBeInstanceOf(GifProviderError);
  });
});
