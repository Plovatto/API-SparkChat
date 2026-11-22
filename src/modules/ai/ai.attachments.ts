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

const ATTACHMENT_AD_PREFIX = 'sparkchat:attachment:v1';
const ATTACHMENT_AD_SEPARATOR = '|';
const ATTACHMENT_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ATTACHMENT_KEY_BYTES = 32;
const ENCRYPTION_OVERHEAD_BYTES = 24 + 16;

export type AttachmentSlot = 'content' | 'thumbnail' | 'preview';

export interface AttachmentBinding {
  roomId: string;
  messageId: string;
  slot: AttachmentSlot;
}

export function attachmentAssociatedData({ roomId, messageId, slot }: AttachmentBinding): string {
  return [ATTACHMENT_AD_PREFIX, roomId, messageId, slot].join(ATTACHMENT_AD_SEPARATOR);
}

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

function decodeAttachmentKey(encodedKey: string | null): Buffer | null {
  if (!encodedKey || !ATTACHMENT_KEY_PATTERN.test(encodedKey)) {
    return null;
  }
  const key = Buffer.from(encodedKey, 'base64url');
  return key.length === ATTACHMENT_KEY_BYTES ? key : null;
}

export async function loadDecryptedAttachment(
  url: string,
  binding: AttachmentBinding,
  encodedKey: string | null,
  objectStorage: ObjectStorage,
  maxBytes: number,
): Promise<Buffer | null> {
  const fileKey = decodeAttachmentKey(encodedKey);
  const objectKey = resolveObjectKey(url);
  if (!fileKey || !objectKey) {
    return null;
  }

  try {
    const sealedLimit = maxBytes + ENCRYPTION_OVERHEAD_BYTES;
    const raw = await objectStorage.getObject(objectKey, { maxBytes: sealedLimit });
    if (!raw || raw.length > sealedLimit) {
      return null;
    }

    const sodium = await getSodium();
    const nonceLength = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    if (raw.length < nonceLength + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES) {
      return null;
    }

    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      raw.subarray(nonceLength),
      attachmentAssociatedData(binding),
      raw.subarray(0, nonceLength),
      fileKey,
    );
    return Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  } catch {
    return null;
  } finally {
    fileKey.fill(0);
  }
}
