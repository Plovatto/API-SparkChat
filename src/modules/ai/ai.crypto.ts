import sodium from 'libsodium-wrappers-sumo';

const E2E_PREFIX = 'e2e:v1:';

let readyPromise: Promise<typeof sodium> | null = null;

export function getSodium(): Promise<typeof sodium> {
  readyPromise ??= sodium.ready.then(() => sodium);
  return readyPromise;
}

export async function unsealRoomKey(
  sealedKeyBase64: string,
  publicKey: Uint8Array,
  privateKey: Uint8Array,
): Promise<Uint8Array | null> {
  const s = await getSodium();

  try {
    const sealed = s.from_base64(sealedKeyBase64);
    return s.crypto_box_seal_open(sealed, publicKey, privateKey);
  } catch {
    return null;
  }
}

export async function decryptContent(content: string, roomKey: Uint8Array): Promise<string | null> {
  if (!content.startsWith(E2E_PREFIX)) {
    return content;
  }

  const s = await getSodium();

  try {
    const combined = s.from_base64(content.slice(E2E_PREFIX.length));
    const nonce = combined.subarray(0, s.crypto_secretbox_NONCEBYTES);
    const ciphertext = combined.subarray(s.crypto_secretbox_NONCEBYTES);
    const plaintext = s.crypto_secretbox_open_easy(ciphertext, nonce, roomKey);
    return s.to_string(plaintext);
  } catch {
    return null;
  }
}

export async function encryptContent(plaintext: string, roomKey: Uint8Array): Promise<string> {
  const s = await getSodium();
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const ciphertext = s.crypto_secretbox_easy(plaintext, nonce, roomKey);
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce, 0);
  combined.set(ciphertext, nonce.length);
  return E2E_PREFIX + s.to_base64(combined);
}
