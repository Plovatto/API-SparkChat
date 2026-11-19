import { describe, expect, it, vi } from 'vitest';
import { GifProviderError, KlipyGifProvider } from '@/modules/gifs/index.js';
import { fetchGifMedia, GIF_MEDIA_MAX_BYTES } from '@/modules/gifs/gifs.media.js';
import type { LinkPreviewTransport } from '@/modules/link-preview/link-preview.http.js';

const URL_OK = 'https://static1.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/eUbp2uNc.webp';
const WEBP = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 '), Buffer.alloc(64, 1)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 2)]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

const assertPublicUrl = (url: string) => Promise.resolve(new URL(url));

function binary(body: Buffer, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(body), { status, headers });
}

function transportReturning(response: Response) {
  return vi.fn<LinkPreviewTransport>(() => Promise.resolve(response));
}

describe('fetchGifMedia', () => {
  it('returns webp bytes with the sniffed type, whatever the server labels them', async () => {
    const transport = transportReturning(binary(WEBP, 200, { 'content-type': 'text/html' }));

    await expect(fetchGifMedia(URL_OK, { transport, assertPublicUrl })).resolves.toEqual({ contentType: 'image/webp', body: WEBP });
    expect(transport.mock.calls[0]?.[1].accept).toBe('image/webp,image/gif');
  });

  it('accepts gif bytes', async () => {
    const transport = transportReturning(binary(GIF));

    await expect(fetchGifMedia(URL_OK.replace('.webp', '.gif'), { transport, assertPublicUrl })).resolves.toMatchObject({ contentType: 'image/gif' });
  });

  it.each([
    ['png', PNG],
    ['svg', SVG],
    ['html', Buffer.from('<html></html>')],
    ['empty', Buffer.alloc(0)],
  ])('refuses %s bytes', async (_label, body) => {
    await expect(fetchGifMedia(URL_OK, { transport: transportReturning(binary(body)), assertPublicUrl })).rejects.toBeInstanceOf(GifProviderError);
  });

  it('refuses bodies over 2 MB', async () => {
    const oversized = Buffer.concat([WEBP, Buffer.alloc(GIF_MEDIA_MAX_BYTES, 0)]);

    await expect(fetchGifMedia(URL_OK, { transport: transportReturning(binary(oversized)), assertPublicUrl })).rejects.toBeInstanceOf(GifProviderError);
  });

  it('accepts a body of exactly 2 MB', async () => {
    const exact = Buffer.concat([WEBP, Buffer.alloc(GIF_MEDIA_MAX_BYTES - WEBP.length, 0)]);

    await expect(fetchGifMedia(URL_OK, { transport: transportReturning(binary(exact)), assertPublicUrl })).resolves.toMatchObject({ contentType: 'image/webp' });
  });

  it('does not follow redirects', async () => {
    const transport = transportReturning(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }));

    await expect(fetchGifMedia(URL_OK, { transport, assertPublicUrl })).rejects.toBeInstanceOf(GifProviderError);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('refuses non-200 answers', async () => {
    await expect(fetchGifMedia(URL_OK, { transport: transportReturning(binary(WEBP, 404)), assertPublicUrl })).rejects.toBeInstanceOf(GifProviderError);
  });

  it('never contacts the network for a URL outside the allow list', async () => {
    const transport = transportReturning(binary(WEBP));
    const guard = vi.fn(assertPublicUrl);

    await expect(fetchGifMedia('https://example.com/a.webp', { transport, assertPublicUrl: guard })).rejects.toBeInstanceOf(GifProviderError);
    expect(guard).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses hosts that resolve to private addresses', async () => {
    const transport = transportReturning(binary(WEBP));
    const guard = vi.fn(() => Promise.reject(new Error('Endereço não permitido.')));

    await expect(fetchGifMedia(URL_OK, { transport, assertPublicUrl: guard })).rejects.toBeInstanceOf(GifProviderError);
    expect(transport).not.toHaveBeenCalled();
  });

  it('gives up after the deadline', async () => {
    const transport = vi.fn<LinkPreviewTransport>(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    await expect(fetchGifMedia(URL_OK, { transport, assertPublicUrl, timeoutMs: 20 })).rejects.toBeInstanceOf(GifProviderError);
  });

  it('is what the KLIPY provider uses to fetch media', async () => {
    const transport = transportReturning(binary(WEBP));
    const provider = new KlipyGifProvider('key', { transport, assertPublicUrl });

    await expect(provider.fetchMedia(URL_OK)).resolves.toMatchObject({ contentType: 'image/webp' });
    expect((transport.mock.calls[0]?.[0] as URL).href).toBe(URL_OK);
  });
});
