import sodium from 'libsodium-wrappers-sumo';
import { ENCRYPTED_FIELD_PREFIX, readEncryptedFieldKeyId } from '../messages/message.encrypted-fields.js';
import { parseRoomKeyEnvelope, roomKeySignedHeader } from '../rooms/room.key-envelope.js';

const AEAD_CONTEXT = 'sparkchat:msg:v2';
const SIGNATURE_CONTEXT = 'sparkchat:msg-sig:v2';
const SIGNING_SEED_CONTEXT = 'sparkchat:signing-seed:v1';
const IDENTITY_BINDING_PREFIX = 'sparkchat:identity-binding:v1:';
const FIELD_SEPARATOR = '|';
const KEY_ID_CONTEXT = 'sparkchat:key-id:v1';
const KEY_ID_BYTES = 16;

let readyPromise: Promise<typeof sodium> | null = null;

export function getSodium(): Promise<typeof sodium> {
  readyPromise ??= sodium.ready.then(() => sodium);
  return readyPromise;
}

export async function deriveKeyId(roomKey: Uint8Array): Promise<string> {
  const s = await getSodium();
  const digest = s.crypto_generichash(32, s.from_string(KEY_ID_CONTEXT), roomKey);
  return s.to_base64(digest.subarray(0, KEY_ID_BYTES));
}

export interface FieldContext {
  roomId: string;
  senderId: string;
  messageId: string;
  label: string;
}

export interface SigningKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export async function deriveSigningKeyPair(privateKey: Uint8Array): Promise<SigningKeyPair> {
  const s = await getSodium();
  const seed = s.crypto_generichash(s.crypto_sign_SEEDBYTES, privateKey, s.from_string(SIGNING_SEED_CONTEXT));
  const pair = s.crypto_sign_seed_keypair(seed);
  seed.fill(0);
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

export async function signIdentityBinding(userId: string, publicKey: string, signingPrivateKey: Uint8Array): Promise<string> {
  const s = await getSodium();
  return s.to_base64(s.crypto_sign_detached(s.from_string(`${IDENTITY_BINDING_PREFIX}${userId}:${publicKey}`), signingPrivateKey));
}

function contextBytes(prefix: string, context: FieldContext, keyId: string): Uint8Array {
  const parts = [prefix, context.roomId, context.senderId, context.messageId, keyId, context.label];
  if (parts.some((part) => part.includes(FIELD_SEPARATOR))) {
    throw new Error('Field context contains the separator');
  }
  return new TextEncoder().encode(parts.join(FIELD_SEPARATOR) + FIELD_SEPARATOR);
}

function signedBytes(context: FieldContext, keyId: string, body: Uint8Array): Uint8Array {
  const prefix = contextBytes(SIGNATURE_CONTEXT, context, keyId);
  const combined = new Uint8Array(prefix.length + body.length);
  combined.set(prefix, 0);
  combined.set(body, prefix.length);
  return combined;
}

export function readFieldKeyId(payload: string): string | null {
  return readEncryptedFieldKeyId(payload);
}

export async function sealField(
  plaintext: string,
  roomKey: Uint8Array,
  keyId: string,
  signingPrivateKey: Uint8Array,
  context: FieldContext,
): Promise<string> {
  const s = await getSodium();
  const body = new TextEncoder().encode(plaintext);
  const signature = s.crypto_sign_detached(signedBytes(context, keyId, body), signingPrivateKey);
  const inner = new Uint8Array(signature.length + body.length);
  inner.set(signature, 0);
  inner.set(body, signature.length);
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const sealed = s.crypto_aead_xchacha20poly1305_ietf_encrypt(inner, contextBytes(AEAD_CONTEXT, context, keyId), null, nonce, roomKey);
  const combined = new Uint8Array(nonce.length + sealed.length);
  combined.set(nonce, 0);
  combined.set(sealed, nonce.length);
  return `${ENCRYPTED_FIELD_PREFIX}${keyId}:${s.to_base64(combined)}`;
}

export async function openField(
  payload: string,
  roomKey: Uint8Array,
  senderSigningPublicKey: Uint8Array,
  context: FieldContext,
): Promise<string | null> {
  const keyId = readFieldKeyId(payload);
  if (!keyId) {
    return null;
  }

  const s = await getSodium();
  try {
    const combined = s.from_base64(payload.slice(ENCRYPTED_FIELD_PREFIX.length + keyId.length + 1));
    const nonceLength = s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    const inner = s.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      combined.subarray(nonceLength),
      contextBytes(AEAD_CONTEXT, context, keyId),
      combined.subarray(0, nonceLength),
      roomKey,
    );
    const signature = inner.subarray(0, s.crypto_sign_BYTES);
    const body = inner.subarray(s.crypto_sign_BYTES);
    if (!s.crypto_sign_verify_detached(signature, signedBytes(context, keyId, body), senderSigningPublicKey)) {
      return null;
    }
    return s.to_string(body);
  } catch {
    return null;
  }
}

export interface EnvelopeOpening {
  sealedKey: string;
  roomId: string;
  keyId: string;
  epoch: number;
  senderId: string;
  senderIsMember: boolean;
  senderPublicKey: string | null;
  senderSigningPublicKey: string | null;
  recipientId: string;
  recipientPublicKey: string;
  recipientPrivateKey: Uint8Array;
}

export async function openRoomKeyEnvelope(opening: EnvelopeOpening): Promise<Uint8Array | null> {
  const envelope = parseRoomKeyEnvelope(opening.sealedKey);
  if (
    !envelope ||
    !opening.senderIsMember ||
    !opening.senderPublicKey ||
    !opening.senderSigningPublicKey ||
    envelope.roomId !== opening.roomId ||
    envelope.keyId !== opening.keyId ||
    envelope.epoch !== opening.epoch ||
    envelope.senderId !== opening.senderId ||
    envelope.recipientId !== opening.recipientId
  ) {
    return null;
  }

  const s = await getSodium();
  try {
    const header = s.from_string(roomKeySignedHeader(envelope, opening.recipientPublicKey));
    if (!s.crypto_sign_verify_detached(s.from_base64(envelope.sig), header, s.from_base64(opening.senderSigningPublicKey))) {
      return null;
    }
    const roomKey = s.crypto_box_open_easy(
      s.from_base64(envelope.box),
      s.from_base64(envelope.nonce),
      s.from_base64(opening.senderPublicKey),
      opening.recipientPrivateKey,
    );
    if (roomKey.length !== s.crypto_secretbox_KEYBYTES || (await deriveKeyId(roomKey)) !== envelope.keyId) {
      return null;
    }
    return roomKey;
  } catch {
    return null;
  }
}
