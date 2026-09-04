import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { uploadsDir, uploadsUrlPrefix } from '../../config/paths.js';
import { getSodium } from './ai.crypto.js';

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

function extractPathname(url: string): string {
  try {
    return new URL(url, 'http://internal').pathname;
  } catch {
    return url.split('?')[0] ?? '';
  }
}

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

export function resolveDiskPath(url: string, uploadsRootDir: string = uploadsDir): string | null {
  const pathname = extractPathname(url);
  if (!pathname.startsWith(`${uploadsUrlPrefix}/`)) {
    return null;
  }

  const relative = pathname.slice(uploadsUrlPrefix.length + 1);
  const uploadsRoot = path.resolve(uploadsRootDir);
  const resolved = path.resolve(uploadsRoot, relative);

  if (resolved !== uploadsRoot && !resolved.startsWith(`${uploadsRoot}${path.sep}`)) {
    return null;
  }

  return resolved;
}

export async function loadDecryptedAttachment(
  url: string,
  roomKey: Uint8Array,
  uploadsRootDir: string = uploadsDir,
): Promise<Buffer | null> {
  const diskPath = resolveDiskPath(url, uploadsRootDir);
  if (!diskPath) {
    return null;
  }

  let raw: Buffer;
  try {
    raw = await readFile(diskPath);
  } catch {
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
