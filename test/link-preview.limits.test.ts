import { describe, expect, it } from 'vitest';
import { deriveSigningKeyPair, getSodium, sealField } from '@/modules/ai/ai.crypto.js';
import {
  encryptedLength,
  fitLinkPreviewForEncryption,
  LINK_PREVIEW_ENCRYPTED_LIMITS,
  maxPlaintextBytes,
  truncateUtf8,
} from '@/modules/link-preview/index.js';

async function createRoomKey(): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
}

async function encryptContent(plaintext: string, roomKey: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  const signing = await deriveSigningKeyPair(sodium.randombytes_buf(32));
  const keyId = sodium.to_base64(sodium.randombytes_buf(16));
  return sealField(plaintext, roomKey, keyId, signing.privateKey, { roomId: 'room', senderId: 'sender', messageId: 'message', label: 'link-title' });
}

describe('encryptedLength', () => {
  it.each(['', 'a', 'ab', 'abc', 'çã', '🎉', 'x'.repeat(2954), '日本語'.repeat(300)])('matches the real ciphertext length for %#', async (plaintext) => {
    const encrypted = await encryptContent(plaintext, await createRoomKey());

    expect(encryptedLength(plaintext)).toBe(encrypted.length);
  });
});

describe('maxPlaintextBytes', () => {
  it.each(Object.values(LINK_PREVIEW_ENCRYPTED_LIMITS))('is the largest plaintext whose ciphertext fits %i chars', (limit) => {
    const max = maxPlaintextBytes(limit);

    expect(encryptedLength('a'.repeat(max))).toBeLessThanOrEqual(limit);
    expect(encryptedLength('a'.repeat(max + 1))).toBeGreaterThan(limit);
  });
});

describe('truncateUtf8', () => {
  it('keeps a string that already fits', () => {
    expect(truncateUtf8('olá', 10)).toBe('olá');
  });

  it('never splits a multibyte character', () => {
    expect(truncateUtf8('aé', 2)).toBe('a');
    expect(truncateUtf8('a🎉b', 4)).toBe('a');
    expect(truncateUtf8('a🎉b', 5)).toBe('a🎉');
  });

  it('produces valid UTF-8 within the byte budget for any input', () => {
    const value = 'ação 🎉 日本 '.repeat(500);
    for (const budget of [0, 1, 2, 3, 4, 5, 7, 100, 999]) {
      const truncated = truncateUtf8(value, budget);
      expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(budget);
      expect(Buffer.from(truncated, 'utf8').toString('utf8')).toBe(truncated);
      expect(value.startsWith(truncated)).toBe(true);
    }
  });
});

describe('fitLinkPreviewForEncryption', () => {
  const base = {
    url: 'https://example.com/a',
    title: 'Título',
    description: 'Descrição',
    imageUrl: 'https://example.com/cover.jpg',
    siteName: 'Example',
  };

  it('keeps a small preview untouched', () => {
    expect(fitLinkPreviewForEncryption(base)).toEqual(base);
  });

  it('truncates multibyte text fields so their encrypted form always fits the message schema', async () => {
    const roomKey = await createRoomKey();
    const fitted = fitLinkPreviewForEncryption({
      ...base,
      title: '🎉'.repeat(5000),
      description: 'ção'.repeat(10000),
      siteName: '日本'.repeat(2000),
    });

    expect(fitted).not.toBeNull();
    expect((await encryptContent(fitted?.title ?? '', roomKey)).length).toBeLessThanOrEqual(LINK_PREVIEW_ENCRYPTED_LIMITS.title);
    expect((await encryptContent(fitted?.description ?? '', roomKey)).length).toBeLessThanOrEqual(LINK_PREVIEW_ENCRYPTED_LIMITS.description);
    expect((await encryptContent(fitted?.siteName ?? '', roomKey)).length).toBeLessThanOrEqual(LINK_PREVIEW_ENCRYPTED_LIMITS.siteName);
    expect(fitted?.title.startsWith('🎉')).toBe(true);
  });

  it('drops an image URL that would not fit once encrypted instead of cutting it', () => {
    const imageUrl = `https://example.com/${'i'.repeat(4000)}.jpg`;

    expect(fitLinkPreviewForEncryption({ ...base, imageUrl })?.imageUrl).toBeNull();
  });

  it('gives up on the preview when the page URL itself would not fit once encrypted', () => {
    const url = `https://example.com/${'p'.repeat(4000)}`;

    expect(fitLinkPreviewForEncryption({ ...base, url })).toBeNull();
  });

  it('gives up when the title is empty after truncation', () => {
    expect(fitLinkPreviewForEncryption({ ...base, title: '   ' })).toBeNull();
  });
});
