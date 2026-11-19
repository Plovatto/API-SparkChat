import { describe, expect, it } from 'vitest';
import { getSodium } from '@/modules/ai/ai.crypto.js';
import { guessMimeTypeFromUrl, loadDecryptedAttachment, resolveAudioMimeType, resolveObjectKey } from '@/modules/ai/ai.attachments.js';
import { InMemoryObjectStorage } from '@/storage/object-storage.js';

describe('guessMimeTypeFromUrl', () => {
  it('maps known image and audio extensions', () => {
    expect(guessMimeTypeFromUrl('https://cdn.test/uploads/images/abc.png')).toBe('image/png');
    expect(guessMimeTypeFromUrl('https://cdn.test/uploads/audio/abc.webm?e2e=1')).toBe('audio/webm');
    expect(guessMimeTypeFromUrl('https://cdn.test/uploads/files/abc.zip')).toBeNull();
  });
});

describe('resolveAudioMimeType', () => {
  it('prefers the declared audio type and drops codec parameters', () => {
    expect(resolveAudioMimeType('audio/webm;codecs=opus', 'https://cdn.test/uploads/audio/abc.bin?e2e=1')).toBe('audio/webm');
    expect(resolveAudioMimeType('audio/x-wav', 'https://cdn.test/uploads/audio/abc.bin?e2e=1')).toBe('audio/wav');
  });

  it('falls back to the url extension when the declared type is missing or not audio', () => {
    expect(resolveAudioMimeType(null, 'https://cdn.test/uploads/audio/abc.m4a?e2e=1')).toBe('audio/mp4');
    expect(resolveAudioMimeType('text/html', 'https://cdn.test/uploads/audio/abc.ogg')).toBe('audio/ogg');
  });

  it('returns null when neither source names a supported audio type', () => {
    expect(resolveAudioMimeType('application/octet-stream', 'https://cdn.test/uploads/audio/abc.bin?e2e=1')).toBeNull();
    expect(resolveAudioMimeType(null, 'https://cdn.test/uploads/images/abc.png')).toBeNull();
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

const KEY_ID_BYTES = Buffer.alloc(16, 7);

function keyring(roomKey: Uint8Array) {
  return (keyId: string) => Promise.resolve(keyId === KEY_ID_BYTES.toString('base64url') ? roomKey : null);
}

describe('loadDecryptedAttachment', () => {
  it('decrypts a sealed attachment written with the room key', async () => {
    const objectStorage = new InMemoryObjectStorage();
    const sodium = await getSodium();
    const roomKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const plaintext = Buffer.from('fake image bytes');

    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, roomKey);
    const combined = Buffer.concat([KEY_ID_BYTES, Buffer.from(nonce), Buffer.from(ciphertext)]);

    await objectStorage.putObject('uploads/images/photo.png', combined, { contentType: 'image/png' });
    const url = `${objectStorage.publicUrl('uploads/images/photo.png')}?e2e=1`;

    const result = await loadDecryptedAttachment(url, keyring(roomKey), objectStorage, 1024 * 1024);
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
    const combined = Buffer.concat([KEY_ID_BYTES, Buffer.from(nonce), Buffer.from(ciphertext)]);

    await objectStorage.putObject('uploads/images/photo.png', combined, { contentType: 'image/png' });
    const url = `${objectStorage.publicUrl('uploads/images/photo.png')}?e2e=1`;

    const result = await loadDecryptedAttachment(url, keyring(otherKey), objectStorage, 1024 * 1024);
    expect(result).toBeNull();
  });

  it('returns null for a key that does not exist', async () => {
    const objectStorage = new InMemoryObjectStorage();
    const sodium = await getSodium();
    const roomKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const url = `${objectStorage.publicUrl('uploads/images/missing.png')}?e2e=1`;

    const result = await loadDecryptedAttachment(url, keyring(roomKey), objectStorage, 1024 * 1024);
    expect(result).toBeNull();
  });

  it('reads the key id from the first 16 bytes and returns null when that generation is unknown', async () => {
    const objectStorage = new InMemoryObjectStorage();
    const sodium = await getSodium();
    const roomKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = sodium.crypto_secretbox_easy(Buffer.from('bytes'), nonce, roomKey);
    const otherKeyId = Buffer.alloc(16, 9);
    await objectStorage.putObject('uploads/images/other.png', Buffer.concat([otherKeyId, Buffer.from(nonce), Buffer.from(ciphertext)]), {
      contentType: 'image/png',
    });
    await objectStorage.putObject('uploads/images/short.png', Buffer.alloc(20), { contentType: 'image/png' });

    const requested: string[] = [];
    const resolver = (keyId: string) => {
      requested.push(keyId);
      return Promise.resolve(null);
    };
    expect(await loadDecryptedAttachment(objectStorage.publicUrl('uploads/images/other.png') + '?e2e=1', resolver, objectStorage, 1024)).toBeNull();
    expect(requested).toEqual([otherKeyId.toString('base64url')]);
    expect(await loadDecryptedAttachment(objectStorage.publicUrl('uploads/images/short.png') + '?e2e=1', keyring(roomKey), objectStorage, 1024)).toBeNull();
  });
});
