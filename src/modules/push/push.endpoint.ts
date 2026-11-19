import { MAX_ENDPOINT_LENGTH, PUSH_ALLOWED_HOST_SUFFIXES, PUSH_ALLOWED_HOSTS } from './push.types.js';

const P256DH_BYTES = 65;
const AUTH_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export function isAllowedPushHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if ((PUSH_ALLOWED_HOSTS as readonly string[]).includes(host)) {
    return true;
  }
  return PUSH_ALLOWED_HOST_SUFFIXES.some((suffix) => host.length > suffix.length && host.endsWith(suffix) && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host.slice(0, -suffix.length)));
}

export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > MAX_ENDPOINT_LENGTH) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === '' && isAllowedPushHost(url.hostname);
}

function decodeKey(value: string, expectedBytes: number): string | null {
  if (!BASE64URL.test(value)) {
    return null;
  }
  const bytes = Buffer.from(value.replace(/=+$/, ''), 'base64url');
  return bytes.length === expectedBytes ? bytes.toString('base64url') : null;
}

export function normalizeP256dh(value: string): string | null {
  const normalized = decodeKey(value, P256DH_BYTES);
  return normalized && Buffer.from(normalized, 'base64url')[0] === 4 ? normalized : null;
}

export function normalizeAuthSecret(value: string): string | null {
  return decodeKey(value, AUTH_BYTES);
}
