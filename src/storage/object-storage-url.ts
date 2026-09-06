import { uploadedMediaKeyPrefix } from '../config/paths.js';

const UPLOADED_MEDIA_KEY_PATTERN = new RegExp(`^${uploadedMediaKeyPrefix}/(?:images|audio|files)/[^/]+$`);

export function extractPathname(url: string): string {
  try {
    return new URL(url, 'http://internal').pathname;
  } catch {
    return url.split('?')[0] ?? '';
  }
}

export function resolveObjectKey(url: string): string | null {
  const key = extractPathname(url).replace(/^\//, '');
  return UPLOADED_MEDIA_KEY_PATTERN.test(key) ? key : null;
}
