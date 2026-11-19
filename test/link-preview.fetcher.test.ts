import { describe, expect, it, vi } from 'vitest';
import { encryptedLength, LINK_PREVIEW_ENCRYPTED_LIMITS } from '@/modules/link-preview/index.js';
import { createHttpLinkPreviewFetcher } from '@/modules/link-preview/link-preview.fetcher.js';

function htmlResponse(html: string, contentType = 'text/html; charset=utf-8'): Response {
  return new Response(html, { status: 200, headers: { 'content-type': contentType } });
}

describe('httpLinkPreviewFetcher', () => {
  it('extracts Open Graph metadata and resolves a relative image URL', async () => {
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="Título &amp; Exemplo" />
      <meta property="og:description" content="Uma descrição." />
      <meta property="og:image" content="/cover.jpg" />
      <meta property="og:site_name" content="Example" />
    </head><body></body></html>`;

    const fetcher = createHttpLinkPreviewFetcher({ transport: vi.fn().mockResolvedValue(htmlResponse(html)) });

    const result = await fetcher.fetchMetadata('https://93.184.216.34/article');

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
    const fetcher = createHttpLinkPreviewFetcher({ transport: vi.fn().mockResolvedValue(htmlResponse(html)) });

    const result = await fetcher.fetchMetadata('https://93.184.216.34/entities');

    expect(result?.title).toBe('Use &lt;div&gt; &amp; CSS');
  });

  it('falls back to the <title> tag when there is no og:title', async () => {
    const html = '<!doctype html><html><head><title>Fallback title</title></head><body></body></html>';
    const fetcher = createHttpLinkPreviewFetcher({ transport: vi.fn().mockResolvedValue(htmlResponse(html)) });

    const result = await fetcher.fetchMetadata('https://93.184.216.34/no-og');

    expect(result?.title).toBe('Fallback title');
  });

  it('returns null when the page has neither og:title nor a <title> tag', async () => {
    const fetcher = createHttpLinkPreviewFetcher({ transport: vi.fn().mockResolvedValue(htmlResponse('<!doctype html><html><head></head><body></body></html>')) });

    const result = await fetcher.fetchMetadata('https://93.184.216.34/empty');

    expect(result).toBeNull();
  });

  it('returns null for a non-HTML, non-image content type', async () => {
    const fetcher = createHttpLinkPreviewFetcher({ transport: vi.fn().mockResolvedValue(htmlResponse('{}', 'application/json')) });

    const result = await fetcher.fetchMetadata('https://93.184.216.34/data.json');

    expect(result).toBeNull();
  });

  it('treats a direct image URL as its own preview, using the filename as the title', async () => {
    const fetcher = createHttpLinkPreviewFetcher({ transport: vi.fn().mockResolvedValue(htmlResponse('', 'image/jpeg')) });

    const result = await fetcher.fetchMetadata('https://93.184.216.34/photos/cat.jpg');

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
    const fetcher = createHttpLinkPreviewFetcher({ transport: vi.fn().mockResolvedValue(htmlResponse(html)) });

    const result = await fetcher.fetchMetadata('https://93.184.216.34/long');

    expect(result).not.toBeNull();
    expect(encryptedLength(result?.title ?? '')).toBeLessThanOrEqual(LINK_PREVIEW_ENCRYPTED_LIMITS.title);
    expect(encryptedLength(result?.description ?? '')).toBeLessThanOrEqual(LINK_PREVIEW_ENCRYPTED_LIMITS.description);
    expect(encryptedLength(result?.siteName ?? '')).toBeLessThanOrEqual(LINK_PREVIEW_ENCRYPTED_LIMITS.siteName);
    expect(result?.imageUrl).toBeNull();
    expect(result?.url).toBe('https://93.184.216.34/long');
  });

  it('reads content before property, single quotes and unquoted values', async () => {
    const html = "<html><head><META content='Ordem invertida' property=og:title><meta name=description content=Curta></head></html>";
    const fetcher = createHttpLinkPreviewFetcher({ transport: vi.fn().mockResolvedValue(htmlResponse(html)) });

    const result = await fetcher.fetchMetadata('https://93.184.216.34/order');

    expect(result?.title).toBe('Ordem invertida');
    expect(result?.description).toBe('Curta');
  });

  it('ignores meta tags that only appear after the head', async () => {
    const html = '<html><head><title>Head title</title></head><body><meta property="og:title" content="Body title"></body></html>';
    const fetcher = createHttpLinkPreviewFetcher({ transport: vi.fn().mockResolvedValue(htmlResponse(html)) });

    const result = await fetcher.fetchMetadata('https://93.184.216.34/body');

    expect(result?.title).toBe('Head title');
  });

  it('parses a page full of unterminated og:title prefixes in linear time', async () => {
    const html = '<html><head>' + '<meta name="og:title" '.repeat(15_000);
    const fetcher = createHttpLinkPreviewFetcher({ transport: vi.fn().mockResolvedValue(htmlResponse(html)) });

    const startedAt = performance.now();
    const result = await fetcher.fetchMetadata('https://93.184.216.34/redos');

    expect(result).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it('gives up on a body that keeps dripping past the deadline', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<html><head><title>Slow'));
      },
    });
    const transport = vi.fn().mockResolvedValue(new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }));
    const fetcher = createHttpLinkPreviewFetcher({ transport, timeoutMs: 50 });

    await expect(fetcher.fetchMetadata('https://93.184.216.34/slow')).rejects.toThrow();
  });

  it('passes an abort signal to every hop and re-validates redirect targets', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://93.184.216.35/next' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }));
    const fetcher = createHttpLinkPreviewFetcher({ transport });

    await expect(fetcher.fetchMetadata('https://93.184.216.34/start')).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(2);
    const calls = transport.mock.calls as [URL, { signal: AbortSignal }][];
    expect(calls[1]?.[0].href).toBe('https://93.184.216.35/next');
    expect(calls.every(([, init]) => init.signal instanceof AbortSignal)).toBe(true);
  });
});
