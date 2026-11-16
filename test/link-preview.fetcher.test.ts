import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptedLength, LINK_PREVIEW_ENCRYPTED_LIMITS } from '@/modules/link-preview/index.js';
import { httpLinkPreviewFetcher } from '@/modules/link-preview/link-preview.fetcher.js';

function htmlResponse(html: string, contentType = 'text/html; charset=utf-8'): Response {
  return new Response(html, { status: 200, headers: { 'content-type': contentType } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('httpLinkPreviewFetcher', () => {
  it('extracts Open Graph metadata and resolves a relative image URL', async () => {
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="Título &amp; Exemplo" />
      <meta property="og:description" content="Uma descrição." />
      <meta property="og:image" content="/cover.jpg" />
      <meta property="og:site_name" content="Example" />
    </head><body></body></html>`;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(html)));

    const result = await httpLinkPreviewFetcher.fetchMetadata('https://93.184.216.34/article');

    expect(result).toEqual({
      url: 'https://93.184.216.34/article',
      title: 'Título & Exemplo',
      description: 'Uma descrição.',
      imageUrl: 'https://93.184.216.34/cover.jpg',
      siteName: 'Example',
    });
  });

  it('decodes escaped entities only once', async () => {
    const html = '<!doctype html><html><head><meta property="og:title" content="Use &amp;lt;div&amp;gt; &amp;amp; CSS" /></head></html>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(html)));

    const result = await httpLinkPreviewFetcher.fetchMetadata('https://93.184.216.34/entities');

    expect(result?.title).toBe('Use &lt;div&gt; &amp; CSS');
  });

  it('falls back to the <title> tag when there is no og:title', async () => {
    const html = '<!doctype html><html><head><title>Fallback title</title></head><body></body></html>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(html)));

    const result = await httpLinkPreviewFetcher.fetchMetadata('https://93.184.216.34/no-og');

    expect(result?.title).toBe('Fallback title');
  });

  it('returns null when the page has neither og:title nor a <title> tag', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse('<!doctype html><html><head></head><body></body></html>')));

    const result = await httpLinkPreviewFetcher.fetchMetadata('https://93.184.216.34/empty');

    expect(result).toBeNull();
  });

  it('returns null for a non-HTML, non-image content type', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse('{}', 'application/json')));

    const result = await httpLinkPreviewFetcher.fetchMetadata('https://93.184.216.34/data.json');

    expect(result).toBeNull();
  });

  it('treats a direct image URL as its own preview, using the filename as the title', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse('', 'image/jpeg')));

    const result = await httpLinkPreviewFetcher.fetchMetadata('https://93.184.216.34/photos/cat.jpg');

    expect(result).toEqual({
      url: 'https://93.184.216.34/photos/cat.jpg',
      title: 'cat.jpg',
      description: null,
      imageUrl: 'https://93.184.216.34/photos/cat.jpg',
      siteName: '93.184.216.34',
    });
  });

  it('truncates long multibyte metadata so it still fits once the client encrypts it', async () => {
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="${'🎉'.repeat(3000)}" />
      <meta property="og:description" content="${'ção'.repeat(5000)}" />
      <meta property="og:site_name" content="${'日本'.repeat(1000)}" />
      <meta property="og:image" content="/${'i'.repeat(5000)}.jpg" />
    </head></html>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(html)));

    const result = await httpLinkPreviewFetcher.fetchMetadata('https://93.184.216.34/long');

    expect(result).not.toBeNull();
    expect(encryptedLength(result?.title ?? '')).toBeLessThanOrEqual(LINK_PREVIEW_ENCRYPTED_LIMITS.title);
    expect(encryptedLength(result?.description ?? '')).toBeLessThanOrEqual(LINK_PREVIEW_ENCRYPTED_LIMITS.description);
    expect(encryptedLength(result?.siteName ?? '')).toBeLessThanOrEqual(LINK_PREVIEW_ENCRYPTED_LIMITS.siteName);
    expect(result?.imageUrl).toBeNull();
    expect(result?.url).toBe('https://93.184.216.34/long');
  });
});
