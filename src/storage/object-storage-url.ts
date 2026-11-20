import { uploadedMediaKeyPrefix } from '../config/paths.js';

const UPLOADED_MEDIA_KEY_PATTERN = new RegExp(`^${uploadedMediaKeyPrefix}/(?:images|audio|files|gifs)/[^/]+$`);
const AVATAR_KEY_PATTERN = new RegExp(`^${uploadedMediaKeyPrefix}/avatars/[0-9a-f-]{36}\\.bin$`);

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

export function resolveAvatarObjectKey(url: string): string | null {
  const key = extractPathname(url).replace(/^\//, '');
  return AVATAR_KEY_PATTERN.test(key) ? key : null;
}
