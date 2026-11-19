import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  createGifProvider,
  FAKE_GIF_EMPTY_QUERY,
  FAKE_GIF_ERROR_QUERY,
  FakeGifProvider,
  GifProviderError,
  isAllowedGifMediaUrl,
  KlipyGifProvider,
} from '@/modules/gifs/index.js';

const GIF_PADDED_LIMIT = 2 * 1024 * 1024;

describe('FakeGifProvider', () => {
  it('serves deterministic pages with allowed media URLs', async () => {
    const first = await new FakeGifProvider().trending(1, 'br');
    const again = await new FakeGifProvider().trending(1, 'br');

    expect(first).toEqual(again);
    expect(first.items).toHaveLength(24);
    expect(first.page).toBe(1);
    expect(first.hasNext).toBe(true);
    expect(first.items.every((item) => isAllowedGifMediaUrl(item.url))).toBe(true);
    expect(new Set(first.items.map((item) => item.id)).size).toBe(24);
  });

  it('pages until the last page and then stops', async () => {
    const provider = new FakeGifProvider({ pageSize: 2, trendingPages: 2, searchPages: 1 });

    expect((await provider.trending(2)).hasNext).toBe(false);
    expect(await provider.trending(3)).toEqual({ items: [], page: 3, hasNext: false });
    expect((await provider.search('cat', 1)).hasNext).toBe(false);
  });

  it('gives different results for different searches', async () => {
    const provider = new FakeGifProvider({ pageSize: 4 });

    const cats = await provider.search('cat', 1);
    const dogs = await provider.search('dog', 1);

    expect(cats.items.map((item) => item.id)).not.toEqual(dogs.items.map((item) => item.id));
    expect(cats.items[0]?.title).toContain('cat');
  });

  it('has reserved queries for the empty and error states', async () => {
    const provider = new FakeGifProvider();

    await expect(provider.search(FAKE_GIF_EMPTY_QUERY, 1)).resolves.toEqual({ items: [], page: 1, hasNext: false });
    await expect(provider.search(FAKE_GIF_ERROR_QUERY, 1)).rejects.toBeInstanceOf(GifProviderError);
  });

  it('serves valid animated webp media of different sizes that match the listed metadata', async () => {
    const provider = new FakeGifProvider();
    const { items } = await provider.trending(1);
    const sizes = new Set<number>();

    for (const item of items) {
      const media = await provider.fetchMedia(item.url);
      const metadata = await sharp(media.body, { animated: true }).metadata();
      expect(media.contentType).toBe('image/webp');
      expect(media.body.length).toBe(item.size);
      expect(media.body.length).toBeLessThanOrEqual(GIF_PADDED_LIMIT);
      expect(metadata.format).toBe('webp');
      expect(metadata.pages).toBeGreaterThan(1);
      expect(metadata.width).toBe(item.width);
      sizes.add(media.body.length);
    }

    expect(sizes.size).toBeGreaterThan(1);
    expect([...sizes].some((size) => size > 256 * 1024)).toBe(true);
    expect([...sizes].some((size) => size < 256 * 1024)).toBe(true);
  }, 30000);

  it('refuses media URLs it did not produce', async () => {
    await expect(
      new FakeGifProvider().fetchMedia('https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/eUbp2uNc.webp'),
    ).rejects.toBeInstanceOf(GifProviderError);
  });
});

describe('createGifProvider', () => {
  it('is off without a key', () => {
    expect(createGifProvider({ nodeEnv: 'production', provider: 'klipy' })).toBeNull();
    expect(createGifProvider({ nodeEnv: 'development', provider: 'klipy', klipyApiKey: undefined })).toBeNull();
  });

  it('uses KLIPY when a key is configured', () => {
    expect(createGifProvider({ nodeEnv: 'production', provider: 'klipy', klipyApiKey: 'key' })).toBeInstanceOf(KlipyGifProvider);
  });

  it('uses the fake provider outside production', () => {
    expect(createGifProvider({ nodeEnv: 'development', provider: 'fake' })).toBeInstanceOf(FakeGifProvider);
    expect(createGifProvider({ nodeEnv: 'test', provider: 'fake', klipyApiKey: 'key' })).toBeInstanceOf(FakeGifProvider);
  });

  it('refuses to start with the fake provider in production', () => {
    expect(() => createGifProvider({ nodeEnv: 'production', provider: 'fake' })).toThrow(/not allowed in production/);
    expect(() => createGifProvider({ nodeEnv: 'production', provider: 'fake', klipyApiKey: 'key' })).toThrow();
  });
});
