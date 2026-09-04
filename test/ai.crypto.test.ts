import { describe, expect, it } from 'vitest';
import { decryptContent, encryptContent, getSodium, unsealRoomKey } from '@/modules/ai/ai.crypto.js';

describe('ai.crypto', () => {
  it('round-trips symmetric message content', async () => {
    const sodium = await getSodium();
    const roomKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);

    const encrypted = await encryptContent('olá, spark!', roomKey);
    expect(encrypted.startsWith('e2e:v1:')).toBe(true);

    await expect(decryptContent(encrypted, roomKey)).resolves.toBe('olá, spark!');
  });

  it('returns content untouched when it has no e2e prefix', async () => {
    const sodium = await getSodium();
    const roomKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);

    await expect(decryptContent('texto simples', roomKey)).resolves.toBe('texto simples');
  });

  it('returns null when the content cannot be decrypted with the given key', async () => {
    const sodium = await getSodium();
    const roomKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const otherKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);

    const encrypted = await encryptContent('segredo', roomKey);
    await expect(decryptContent(encrypted, otherKey)).resolves.toBeNull();
  });

  it('unseals a room key that was sealed for the assistant public key', async () => {
    const sodium = await getSodium();
    const keyPair = sodium.crypto_box_keypair();
    const roomKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const sealed = sodium.crypto_box_seal(roomKey, keyPair.publicKey);

    const unsealed = await unsealRoomKey(sodium.to_base64(sealed), keyPair.publicKey, keyPair.privateKey);
    expect(unsealed).toEqual(roomKey);
  });

  it('returns null when unsealing with the wrong key pair', async () => {
    const sodium = await getSodium();
    const keyPair = sodium.crypto_box_keypair();
    const otherKeyPair = sodium.crypto_box_keypair();
    const roomKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const sealed = sodium.crypto_box_seal(roomKey, keyPair.publicKey);

    const unsealed = await unsealRoomKey(sodium.to_base64(sealed), otherKeyPair.publicKey, otherKeyPair.privateKey);
    expect(unsealed).toBeNull();
  });
});
