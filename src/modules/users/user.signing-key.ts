import { createPublicKey, verify } from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function identityBindingMessage(userId: string, publicKey: string): Buffer {
  return Buffer.from(`sparkchat:identity-binding:v1:${userId}:${publicKey}`, 'utf8');
}

function decodeBase64Url(value: string, length: number): Buffer | null {
  if (!BASE64URL.test(value)) {
    return null;
  }
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === length ? bytes : null;
}

export function verifyIdentityBinding(params: {
  userId: string;
  publicKey: string;
  signingPublicKey: string;
  keySignature: string;
}): boolean {
  const signingKey = decodeBase64Url(params.signingPublicKey, 32);
  const signature = decodeBase64Url(params.keySignature, 64);
  if (!signingKey || !signature) {
    return false;
  }

  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, signingKey]), format: 'der', type: 'spki' });
    return verify(null, identityBindingMessage(params.userId, params.publicKey), key, signature);
  } catch {
    return false;
  }
}
