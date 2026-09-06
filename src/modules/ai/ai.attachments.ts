import path from 'node:path';
import { extractPathname, resolveObjectKey } from '../../storage/object-storage-url.js';
import type { ObjectStorage } from '../../storage/object-storage.js';
import { getSodium } from './ai.crypto.js';

export { resolveObjectKey };

const EXTENSION_MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp4': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function isEncryptedUrl(url: string): boolean {
  try {
    return new URL(url, 'http://internal').searchParams.get('e2e') === '1';
  } catch {
    return url.includes('e2e=1');
  }
}

export function guessMimeTypeFromUrl(url: string): string | null {
  const extension = path.extname(extractPathname(url)).toLowerCase();
  return EXTENSION_MIME_TYPES[extension] ?? null;
}

export async function loadDecryptedAttachment(
  url: string,
  roomKey: Uint8Array,
  objectStorage: ObjectStorage,
): Promise<Buffer | null> {
  const key = resolveObjectKey(url);
  if (!key) {
    return null;
  }

  const raw = await objectStorage.getObject(key);
  if (!raw) {
    return null;
  }

  if (!isEncryptedUrl(url)) {
    return raw;
  }

  const sodium = await getSodium();
  try {
    const nonce = raw.subarray(0, sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = raw.subarray(sodium.crypto_secretbox_NONCEBYTES);
    const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, roomKey);
    return Buffer.from(plaintext);
  } catch {
    return null;
  }
}
