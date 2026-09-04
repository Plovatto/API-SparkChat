import { fetchWithGuard, readBodyBuffer } from './link-preview.http.js';
import { assertPublicHttpUrl } from './link-preview.ssrf-guard.js';
import type { LinkPreviewFetcher, LinkPreviewMetadata } from './link-preview.types.js';

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 5000;
const MAX_HTML_BYTES = 300_000;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function buildMetaPatterns(names: string[]): RegExp[] {
  const patterns: RegExp[] = [];
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.push(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'));
    patterns.push(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i'));
  }
  return patterns;
}

function extractMetaContent(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    const content = match?.[1];
    if (content) {
      return decodeHtmlEntities(content.trim());
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

function parseHtmlMetadata(html: string, pageUrl: URL): LinkPreviewMetadata | null {
  const titleTagMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title =
    extractMetaContent(html, buildMetaPatterns(['og:title', 'twitter:title'])) ??
    (titleTagMatch?.[1] ? decodeHtmlEntities(titleTagMatch[1].trim()) : null);

  if (!title) {
    return null;
  }

  const description = extractMetaContent(html, buildMetaPatterns(['og:description', 'twitter:description', 'description']));
  const siteName = extractMetaContent(html, buildMetaPatterns(['og:site_name']));
  const rawImage = extractMetaContent(html, buildMetaPatterns(['og:image', 'twitter:image']));
  const imageUrl = rawImage ? resolveUrl(rawImage, pageUrl) : null;

  return { url: pageUrl.href, title, description, imageUrl, siteName };
}

async function fetchMetadata(rawUrl: string): Promise<LinkPreviewMetadata | null> {
  let currentUrl = await assertPublicHttpUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchWithGuard(currentUrl, FETCH_TIMEOUT_MS, 'text/html,image/*');

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirectCount === MAX_REDIRECTS) {
        return null;
      }
      currentUrl = await assertPublicHttpUrl(new URL(location, currentUrl).href);
      continue;
    }

    if (!response.ok) {
      return null;
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

    if (contentType.startsWith('image/')) {
      await response.body?.cancel().catch(() => undefined);
      return { url: currentUrl.href, title: deriveTitleFromUrl(currentUrl), description: null, imageUrl: currentUrl.href, siteName: currentUrl.hostname };
    }

    if (!contentType.startsWith('text/html')) {
      return null;
    }

    const buffer = await readBodyBuffer(response, MAX_HTML_BYTES, true);
    return buffer ? parseHtmlMetadata(buffer.toString('utf-8'), currentUrl) : null;
  }

  return null;
}

export const httpLinkPreviewFetcher: LinkPreviewFetcher = { fetchMetadata };
