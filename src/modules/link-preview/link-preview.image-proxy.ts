import { fetchWithGuard, readBodyBuffer } from './link-preview.http.js';
import { assertPublicHttpUrl } from './link-preview.ssrf-guard.js';

const IMAGE_FETCH_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ProxiedImage {
  contentType: string;
  body: Buffer;
}

export async function fetchProxiedImage(rawUrl: string): Promise<ProxiedImage | null> {
  const url = await assertPublicHttpUrl(rawUrl);
  const response = await fetchWithGuard(url, IMAGE_FETCH_TIMEOUT_MS, 'image/*');

  if (!response.ok) {
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('image/')) {
    return null;
  }

  const body = await readBodyBuffer(response, MAX_IMAGE_BYTES, false);
  return body ? { contentType, body } : null;
}
