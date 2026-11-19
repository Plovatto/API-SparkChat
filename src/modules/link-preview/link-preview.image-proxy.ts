import { discardBody, pinnedTransport, readBodyBuffer, withDeadline, type LinkPreviewTransport } from './link-preview.http.js';
import { assertPublicHttpUrl } from './link-preview.ssrf-guard.js';

const IMAGE_FETCH_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ProxiedImage {
  contentType: string;
  body: Buffer;
}

export interface ImageProxyOptions {
  transport?: LinkPreviewTransport;
  timeoutMs?: number;
}

function startsWithBytes(body: Buffer, signature: number[], offset = 0): boolean {
  return signature.every((byte, index) => body[offset + index] === byte);
}

export function sniffRasterImageType(body: Buffer): string | null {
  if (startsWithBytes(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWithBytes(body, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (startsWithBytes(body, [0x47, 0x49, 0x46, 0x38])) {
    return 'image/gif';
  }
  if (startsWithBytes(body, [0x52, 0x49, 0x46, 0x46]) && startsWithBytes(body, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  return null;
}

export async function fetchProxiedImage(rawUrl: string, options: ImageProxyOptions = {}): Promise<ProxiedImage | null> {
  const transport = options.transport ?? pinnedTransport;
  const url = await assertPublicHttpUrl(rawUrl);

  return withDeadline(options.timeoutMs ?? IMAGE_FETCH_TIMEOUT_MS, async (signal) => {
    const response = await transport(url, { signal, accept: 'image/png,image/jpeg,image/gif,image/webp' });

    if (!response.ok) {
      await discardBody(response);
      return null;
    }

    const body = await readBodyBuffer(response, MAX_IMAGE_BYTES, false, signal);
    if (!body) {
      return null;
    }

    const contentType = sniffRasterImageType(body);
    return contentType ? { contentType, body } : null;
  });
}
