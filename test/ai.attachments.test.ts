import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSodium } from '@/modules/ai/ai.crypto.js';
import { guessMimeTypeFromUrl, loadDecryptedAttachment, resolveDiskPath } from '@/modules/ai/ai.attachments.js';

let uploadsRoot: string;

beforeEach(async () => {
  uploadsRoot = await mkdtemp(path.join(tmpdir(), 'sparkchat-ai-uploads-'));
  await mkdir(path.join(uploadsRoot, 'images'), { recursive: true });
});

afterEach(async () => {
  await rm(uploadsRoot, { recursive: true, force: true });
});

describe('guessMimeTypeFromUrl', () => {
  it('maps known image and audio extensions', () => {
    expect(guessMimeTypeFromUrl('/uploads/images/abc.png')).toBe('image/png');
    expect(guessMimeTypeFromUrl('/uploads/audio/abc.webm?e2e=1')).toBe('audio/webm');
    expect(guessMimeTypeFromUrl('/uploads/files/abc.zip')).toBeNull();
  });
});

describe('resolveDiskPath', () => {
  it('resolves a normal uploads url to a path inside the uploads root', () => {
    const resolved = resolveDiskPath('/uploads/images/abc.png', uploadsRoot);
    expect(resolved).toBe(path.join(uploadsRoot, 'images', 'abc.png'));
  });

  it('rejects a path traversal attempt', () => {
    expect(resolveDiskPath('/uploads/../../secrets.env', uploadsRoot)).toBeNull();
  });

  it('rejects a url outside the uploads prefix', () => {
    expect(resolveDiskPath('/etc/passwd', uploadsRoot)).toBeNull();
  });
});

describe('loadDecryptedAttachment', () => {
  it('decrypts a sealed attachment written with the room key', async () => {
    const sodium = await getSodium();
    const roomKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const plaintext = Buffer.from('fake image bytes');

    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, roomKey);
    const combined = Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]);

    await writeFile(path.join(uploadsRoot, 'images', 'photo.png'), combined);

    const result = await loadDecryptedAttachment('/uploads/images/photo.png?e2e=1', roomKey, uploadsRoot);
    expect(result?.toString('utf8')).toBe('fake image bytes');
  });

  it('returns null when the room key does not match', async () => {
    const sodium = await getSodium();
    const roomKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const otherKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const plaintext = Buffer.from('fake image bytes');

    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, roomKey);
    const combined = Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]);

    await writeFile(path.join(uploadsRoot, 'images', 'photo.png'), combined);

    const result = await loadDecryptedAttachment('/uploads/images/photo.png?e2e=1', otherKey, uploadsRoot);
    expect(result).toBeNull();
  });

  it('returns null for a file that does not exist', async () => {
    const sodium = await getSodium();
    const roomKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const result = await loadDecryptedAttachment('/uploads/images/missing.png?e2e=1', roomKey, uploadsRoot);
    expect(result).toBeNull();
  });
});
