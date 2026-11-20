import { hashLeaf, sha256 } from './transparency.merkle.js';

const LEAF_ID_DOMAIN = 'sparkchat:kt:leaf-id:v1:';
const LEAF_FORMAT_VERSION = 1;
const MAX_KEY_BYTES = 255;

export interface LeafContent {
  leafId: Buffer;
  version: number;
  identityKey: string;
  signingKey: string;
}

export function leafIdOf(userId: string): Buffer {
  return sha256(Buffer.from(LEAF_ID_DOMAIN, 'utf8'), Buffer.from(userId, 'utf8'));
}

export function encodeLeaf(content: LeafContent): Buffer {
  const identity = Buffer.from(content.identityKey, 'utf8');
  const signing = Buffer.from(content.signingKey, 'utf8');
  if (content.leafId.length !== 32 || identity.length === 0 || identity.length > MAX_KEY_BYTES || signing.length > MAX_KEY_BYTES) {
    throw new RangeError('invalid key transparency leaf');
  }
  if (!Number.isInteger(content.version) || content.version < 1 || content.version > 0xffffffff) {
    throw new RangeError('invalid key transparency leaf version');
  }
  const version = Buffer.alloc(4);
  version.writeUInt32BE(content.version);
  const identityLength = Buffer.alloc(2);
  identityLength.writeUInt16BE(identity.length);
  const signingLength = Buffer.alloc(2);
  signingLength.writeUInt16BE(signing.length);
  return Buffer.concat([Buffer.from([LEAF_FORMAT_VERSION]), content.leafId, version, identityLength, identity, signingLength, signing]);
}

export function leafHashOf(content: LeafContent): Buffer {
  return hashLeaf(encodeLeaf(content));
}
