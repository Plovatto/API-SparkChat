import { describe, expect, it } from 'vitest';
import { getSodium } from '@/modules/ai/ai.crypto.js';
import { guessMimeTypeFromUrl, loadDecryptedAttachment, resolveObjectKey } from '@/modules/ai/ai.attachments.js';
import { InMemoryObjectStorage } from '@/storage/object-storage.js';

describe('guessMimeTypeFromUrl', () => {
  it('maps known image and audio extensions', () => {
    expect(guessMimeTypeFromUrl('https://cdn.test/uploads/images/abc.png')).toBe('image/png');
    expect(guessMimeTypeFromUrl('https://cdn.test/uploads/audio/abc.webm?e2e=1')).toBe('audio/webm');
    expect(guessMimeTypeFromUrl('https://cdn.test/uploads/files/abc.zip')).toBeNull();
  });
});

describe('resolveObjectKey', () => {
  it('resolves an uploaded media url to its object key', () => {
    expect(resolveObjectKey('https://cdn.test/uploads/images/abc.png')).toBe('uploads/images/abc.png');
    expect(resolveObjectKey('https://cdn.test/uploads/audio/abc.webm?e2e=1')).toBe('uploads/audio/abc.webm');
  });

  it('rejects a url outside the uploaded-media namespace', () => {
    expect(resolveObjectKey('https://cdn.test/secrets.env')).toBeNull();
  });

  it('rejects a path traversal attempt', () => {
    expect(resolveObjectKey('https://cdn.test/uploads/../../secrets.env')).toBeNull();
  });

  it('rejects a value that does not point into the uploads namespace', () => {
    expect(resolveObjectKey('/etc/passwd')).toBeNull();
  });
});

describe('loadDecryptedAttachment', () => {
  it('decrypts a sealed attachment written with the room key', async () => {
    const objectStorage = new InMemoryObjectStorage();
    const sodium = await getSodium();
    const roomKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const plaintext = Buffer.from('fake image bytes');

    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, roomKey);
    const combined = Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]);

    await objectStorage.putObject('uploads/images/photo.png', combined, { contentType: 'image/png' });
    const url = `${objectStorage.publicUrl('uploads/images/photo.png')}?e2e=1`;

    const result = await loadDecryptedAttachment(url, roomKey, objectStorage);
    expect(result?.toString('utf8')).toBe('fake image bytes');
  });

  it('returns null when the room key does not match', async () => {
    const objectStorage = new InMemoryObjectStorage();
    const sodium = await getSodium();
    const roomKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const otherKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const plaintext = Buffer.from('fake image bytes');

    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, roomKey);
    const combined = Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]);

    await objectStorage.putObject('uploads/images/photo.png', combined, { contentType: 'image/png' });
    const url = `${objectStorage.publicUrl('uploads/images/photo.png')}?e2e=1`;

    const result = await loadDecryptedAttachment(url, otherKey, objectStorage);
    expect(result).toBeNull();
  });

  it('returns null for a key that does not exist', async () => {
    const objectStorage = new InMemoryObjectStorage();
    const sodium = await getSodium();
    const roomKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const url = `${objectStorage.publicUrl('uploads/images/missing.png')}?e2e=1`;

    const result = await loadDecryptedAttachment(url, roomKey, objectStorage);
    expect(result).toBeNull();
  });
});
