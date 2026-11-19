export const ROOM_KEY_ENVELOPE_VERSION = 2;
export const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const NONCE_BYTES = 24;
const BOX_BYTES = 32 + 16;
const SIGNATURE_BYTES = 64;
const ENVELOPE_FIELDS = ['v', 'roomId', 'keyId', 'epoch', 'senderId', 'recipientId', 'nonce', 'box', 'sig'] as const;

export interface RoomKeyEnvelope {
  v: typeof ROOM_KEY_ENVELOPE_VERSION;
  roomId: string;
  keyId: string;
  epoch: number;
  senderId: string;
  recipientId: string;
  nonce: string;
  box: string;
  sig: string;
}

export interface RoomKeyEnvelopeExpectation {
  roomId: string;
  keyId: string;
  epoch: number;
  senderId: string;
  recipientId: string;
}

function decodedLength(value: unknown): number | null {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    return null;
  }
  return Buffer.from(value, 'base64url').length;
}

export function parseRoomKeyEnvelope(sealedKey: string): RoomKeyEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sealedKey);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== ENVELOPE_FIELDS.length || !ENVELOPE_FIELDS.every((field) => keys.includes(field))) {
    return null;
  }

  const { v, roomId, keyId, epoch, senderId, recipientId, nonce, box, sig } = record;
  if (v !== ROOM_KEY_ENVELOPE_VERSION || typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) {
    return null;
  }
  if (typeof roomId !== 'string' || typeof senderId !== 'string' || typeof recipientId !== 'string') {
    return null;
  }
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    return null;
  }
  if (decodedLength(nonce) !== NONCE_BYTES || decodedLength(box) !== BOX_BYTES || decodedLength(sig) !== SIGNATURE_BYTES) {
    return null;
  }

  return { v, roomId, keyId, epoch, senderId, recipientId, nonce: nonce as string, box: box as string, sig: sig as string };
}

export function matchesEnvelope(envelope: RoomKeyEnvelope, expected: RoomKeyEnvelopeExpectation): boolean {
  return (
    envelope.roomId === expected.roomId &&
    envelope.keyId === expected.keyId &&
    envelope.epoch === expected.epoch &&
    envelope.senderId === expected.senderId &&
    envelope.recipientId === expected.recipientId
  );
}

export function roomKeySignedHeader(envelope: RoomKeyEnvelope, recipientPublicKey: string): string {
  return [
    'sparkchat:room-key:v2',
    envelope.roomId,
    envelope.keyId,
    String(envelope.epoch),
    envelope.senderId,
    envelope.recipientId,
    recipientPublicKey,
    envelope.nonce,
    envelope.box,
  ].join('\n');
}
