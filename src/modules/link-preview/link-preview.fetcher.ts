import { discardBody, pinnedTransport, readBodyBuffer, withDeadline, type LinkPreviewTransport } from './link-preview.http.js';
import { scanHeadTags } from './link-preview.html.js';
import { fitLinkPreviewForEncryption } from './link-preview.limits.js';
import { assertPublicHttpUrl } from './link-preview.ssrf-guard.js';
import type { LinkPreviewFetcher, LinkPreviewMetadata } from './link-preview.types.js';

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 5000;
const MAX_HTML_BYTES = 64 * 1024;

export interface HttpLinkPreviewFetcherOptions {
  transport?: LinkPreviewTransport;
  timeoutMs?: number;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function firstMetaContent(meta: Map<string, string>, names: string[]): string | null {
  for (const name of names) {
    const content = meta.get(name)?.trim();
    if (content) {
      return decodeHtmlEntities(content);
    }
  }
  return null;
}

function resolveUrl(value: string, base: URL): string | null {
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

function deriveTitleFromUrl(url: URL): string {
  const segments = url.pathname.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) {
    return url.hostname;
  }

  try {
    return decodeURIComponent(lastSegment);
  } catch {
    return lastSegment;
  }
}

export function parseHtmlMetadata(html: string, pageUrl: URL): LinkPreviewMetadata | null {
  const { meta, title: titleTag } = scanHeadTags(html);
  const trimmedTitleTag = titleTag?.trim();
  const title = firstMetaContent(meta, ['og:title', 'twitter:title']) ?? (trimmedTitleTag ? decodeHtmlEntities(trimmedTitleTag) : null);

  if (!title) {
    return null;
  }

  const description = firstMetaContent(meta, ['og:description', 'twitter:description', 'description']);
  const siteName = firstMetaContent(meta, ['og:site_name']);
  const rawImage = firstMetaContent(meta, ['og:image', 'twitter:image']);
  const imageUrl = rawImage ? resolveUrl(rawImage, pageUrl) : null;

  return { url: pageUrl.href, title, description, imageUrl, siteName };
}

async function fetchRawMetadata(rawUrl: string, transport: LinkPreviewTransport, signal: AbortSignal): Promise<LinkPreviewMetadata | null> {
  let currentUrl = await assertPublicHttpUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await transport(currentUrl, { signal, accept: 'text/html,image/*' });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await discardBody(response);
      if (!location || redirectCount === MAX_REDIRECTS) {
        return null;
      }
      currentUrl = await assertPublicHttpUrl(new URL(location, currentUrl).href);
      continue;
    }

    if (!response.ok) {
      await discardBody(response);
      return null;
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

    if (contentType.startsWith('image/')) {
      await discardBody(response);
      return { url: currentUrl.href, title: deriveTitleFromUrl(currentUrl), description: null, imageUrl: currentUrl.href, siteName: currentUrl.hostname };
    }

    if (!contentType.startsWith('text/html')) {
      await discardBody(response);
      return null;
    }

    const buffer = await readBodyBuffer(response, MAX_HTML_BYTES, true, signal);
    return buffer ? parseHtmlMetadata(buffer.toString('utf-8'), currentUrl) : null;
  }

  return null;
}

export function createHttpLinkPreviewFetcher(options: HttpLinkPreviewFetcherOptions = {}): LinkPreviewFetcher {
  const transport = options.transport ?? pinnedTransport;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

  return {
    fetchMetadata: async (rawUrl: string) => {
      const metadata = await withDeadline(timeoutMs, (signal) => fetchRawMetadata(rawUrl, transport, signal));
      return metadata ? fitLinkPreviewForEncryption(metadata) : null;
    },
  };
}

export const httpLinkPreviewFetcher: LinkPreviewFetcher = createHttpLinkPreviewFetcher();
