import type { LinkPreviewMetadata } from './link-preview.types.js';

export const LINK_PREVIEW_ENCRYPTED_LIMITS = {
  url: 4000,
  title: 4000,
  description: 8000,
  imageUrl: 4000,
  siteName: 1000,
} as const;

const KEY_ID_LENGTH = 22;
const ENCRYPTED_PREFIX_LENGTH = 'e2e:v2:'.length + KEY_ID_LENGTH + 1;
const ENCRYPTION_OVERHEAD_BYTES = 24 + 16 + 64;

export function encryptedLength(plaintext: string): number {
  const bytes = Buffer.byteLength(plaintext, 'utf8') + ENCRYPTION_OVERHEAD_BYTES;
  return ENCRYPTED_PREFIX_LENGTH + Math.ceil((bytes * 4) / 3);
}

export function maxPlaintextBytes(encryptedLimit: number): number {
  return Math.max(0, Math.floor(((encryptedLimit - ENCRYPTED_PREFIX_LENGTH) * 3) / 4) - ENCRYPTION_OVERHEAD_BYTES);
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }

  let usedBytes = 0;
  let result = '';
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (usedBytes + charBytes > maxBytes) {
      break;
    }
    usedBytes += charBytes;
    result += char;
  }
  return result;
}

function fitText(value: string, encryptedLimit: number): string {
  return truncateUtf8(value, maxPlaintextBytes(encryptedLimit)).trim();
}

function fitsWithoutTruncation(value: string, encryptedLimit: number): boolean {
  return Buffer.byteLength(value, 'utf8') <= maxPlaintextBytes(encryptedLimit);
}

export function fitLinkPreviewForEncryption(metadata: LinkPreviewMetadata): LinkPreviewMetadata | null {
  if (!fitsWithoutTruncation(metadata.url, LINK_PREVIEW_ENCRYPTED_LIMITS.url)) {
    return null;
  }

  const title = fitText(metadata.title, LINK_PREVIEW_ENCRYPTED_LIMITS.title);
  if (!title) {
    return null;
  }

  const description = metadata.description ? fitText(metadata.description, LINK_PREVIEW_ENCRYPTED_LIMITS.description) : '';
  const siteName = metadata.siteName ? fitText(metadata.siteName, LINK_PREVIEW_ENCRYPTED_LIMITS.siteName) : '';
  const imageUrl =
    metadata.imageUrl && fitsWithoutTruncation(metadata.imageUrl, LINK_PREVIEW_ENCRYPTED_LIMITS.imageUrl) ? metadata.imageUrl : null;

  return {
    url: metadata.url,
    title,
    description: description || null,
    imageUrl,
    siteName: siteName || null,
  };
}
