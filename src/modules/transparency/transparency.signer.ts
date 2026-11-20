import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const HEAD_DOMAIN = 'sparkchat:kt:sth:v1\n';
const SEED_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface SignedTreeHead {
  size: number;
  root: string;
  issuedAt: number;
  signature: string;
}

export function headSigningBytes(size: number, root: Buffer, issuedAt: number): Buffer {
  const numbers = Buffer.alloc(16);
  numbers.writeBigUInt64BE(BigInt(size), 0);
  numbers.writeBigUInt64BE(BigInt(issuedAt), 8);
  return Buffer.concat([Buffer.from(HEAD_DOMAIN, 'utf8'), numbers.subarray(0, 8), root, numbers.subarray(8)]);
}

export function parseSigningSeed(value: string): Buffer {
  const seed = BASE64URL.test(value) ? Buffer.from(value, 'base64url') : Buffer.alloc(0);
  if (seed.length !== SEED_BYTES) {
    throw new Error('KT_LOG_SIGNING_KEY must be 32 bytes encoded as base64url.');
  }
  return seed;
}

export function generateSigningSeed(): string {
  return randomBytes(SEED_BYTES).toString('base64url');
}

export class TreeHeadSigner {
  private readonly privateKey: KeyObject;
  readonly publicKey: string;

  constructor(seed: Buffer) {
    this.privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    this.publicKey = createPublicKey(this.privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  }

  static ephemeral(): TreeHeadSigner {
    const { privateKey } = generateKeyPairSync('ed25519');
    const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-SEED_BYTES);
    return new TreeHeadSigner(seed);
  }

  sign(size: number, root: Buffer, issuedAt: number): SignedTreeHead {
    const signature = sign(null, headSigningBytes(size, root, issuedAt), this.privateKey);
    return { size, root: root.toString('base64url'), issuedAt, signature: signature.toString('base64url') };
  }
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifySignedTreeHead(head: SignedTreeHead, logPublicKey: string): boolean {
  if (!BASE64URL.test(head.root) || !BASE64URL.test(head.signature) || !BASE64URL.test(logPublicKey)) {
    return false;
  }
  const root = Buffer.from(head.root, 'base64url');
  const signature = Buffer.from(head.signature, 'base64url');
  const publicKey = Buffer.from(logPublicKey, 'base64url');
  if (root.length !== 32 || signature.length !== 64 || publicKey.length !== 32) {
    return false;
  }
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
    return verify(null, headSigningBytes(head.size, root, head.issuedAt), key, signature);
  } catch {
    return false;
  }
}
