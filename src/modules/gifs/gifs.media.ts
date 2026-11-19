import { discardBody, pinnedTransport, readBodyBuffer, withDeadline, type LinkPreviewTransport } from '../link-preview/link-preview.http.js';
import { sniffRasterImageType } from '../link-preview/link-preview.image-proxy.js';
import { assertPublicHttpUrl } from '../link-preview/link-preview.ssrf-guard.js';
import { isAllowedGifMediaUrl } from './gifs.media-url.js';
import { GifProviderError, type GifMedia } from './gifs.provider.js';

export const GIF_MEDIA_TIMEOUT_MS = 8000;
export const GIF_MEDIA_MAX_BYTES = 2 * 1024 * 1024;

export interface GifMediaFetchOptions {
  transport?: LinkPreviewTransport;
  assertPublicUrl?: (url: string) => Promise<URL>;
  timeoutMs?: number;
}

function isGifMediaType(type: string | null): type is GifMedia['contentType'] {
  return type === 'image/webp' || type === 'image/gif';
}

export async function fetchGifMedia(rawUrl: string, options: GifMediaFetchOptions = {}): Promise<GifMedia> {
  if (!isAllowedGifMediaUrl(rawUrl)) {
    throw new GifProviderError();
  }

  const transport = options.transport ?? pinnedTransport;
  const assertPublicUrl = options.assertPublicUrl ?? assertPublicHttpUrl;

  try {
    const url = await assertPublicUrl(rawUrl);
    return await withDeadline(options.timeoutMs ?? GIF_MEDIA_TIMEOUT_MS, async (signal) => {
      const response = await transport(url, { signal, accept: 'image/webp,image/gif' });
      if (response.status !== 200) {
        await discardBody(response);
        throw new GifProviderError();
      }

      const body = await readBodyBuffer(response, GIF_MEDIA_MAX_BYTES, false, signal);
      const contentType = body ? sniffRasterImageType(body) : null;
      if (!body || !isGifMediaType(contentType)) {
        throw new GifProviderError();
      }

      return { contentType, body };
    });
  } catch {
    throw new GifProviderError();
  }
}
