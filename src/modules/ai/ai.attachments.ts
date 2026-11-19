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

const ATTACHMENT_KEY_ID_BYTES = 16;
const ENCRYPTION_OVERHEAD_BYTES = ATTACHMENT_KEY_ID_BYTES + 64;

export function guessMimeTypeFromUrl(url: string): string | null {
  const extension = path.extname(extractPathname(url)).toLowerCase();
  return EXTENSION_MIME_TYPES[extension] ?? null;
}

const AUDIO_MIME_ALIASES: Record<string, string> = {
  'audio/x-wav': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
};

const SUPPORTED_AUDIO_MIME_TYPES = new Set(
  Object.values(EXTENSION_MIME_TYPES).filter((mimeType) => mimeType.startsWith('audio/')),
);

export function resolveAudioMimeType(declaredMimeType: string | null, url: string): string | null {
  const normalized = declaredMimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
  const canonical = AUDIO_MIME_ALIASES[normalized] ?? normalized;
  if (SUPPORTED_AUDIO_MIME_TYPES.has(canonical)) {
    return canonical;
  }

  const guessed = guessMimeTypeFromUrl(url);
  return guessed?.startsWith('audio/') ? guessed : null;
}

export type AttachmentKeyResolver = (keyId: string) => Promise<Uint8Array | null>;

export async function loadDecryptedAttachment(
  url: string,
  resolveKey: AttachmentKeyResolver,
  objectStorage: ObjectStorage,
  maxBytes: number,
): Promise<Buffer | null> {
  const key = resolveObjectKey(url);
  if (!key) {
    return null;
  }

  const raw = await objectStorage.getObject(key);
  if (!raw || raw.length > maxBytes + ENCRYPTION_OVERHEAD_BYTES) {
    return null;
  }

  if (!isEncryptedUrl(url)) {
    return raw;
  }

  const sodium = await getSodium();
  const headerLength = ATTACHMENT_KEY_ID_BYTES + sodium.crypto_secretbox_NONCEBYTES;
  if (raw.length < headerLength + sodium.crypto_secretbox_MACBYTES) {
    return null;
  }

  const roomKey = await resolveKey(raw.subarray(0, ATTACHMENT_KEY_ID_BYTES).toString('base64url'));
  if (!roomKey) {
    return null;
  }

  try {
    const nonce = raw.subarray(ATTACHMENT_KEY_ID_BYTES, headerLength);
    const ciphertext = raw.subarray(headerLength);
    const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, roomKey);
    return Buffer.from(plaintext);
  } catch {
    return null;
  }
}
