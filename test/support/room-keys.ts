import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { buildAssistantIdentity, type AssistantIdentity } from '@/modules/ai/ai.identity.js';
import { getSodium } from '@/modules/ai/ai.crypto.js';
import type { RoomKeyRepository } from '@/modules/rooms/room.e2e.js';
import { roomKeySignedHeader, type RoomKeyEnvelope } from '@/modules/rooms/room.key-envelope.js';

export const TEST_KEY_ID = 'AAAAAAAAAAAAAAAAAAAAAA';

export function newKeyId(): string {
  return randomBytes(16).toString('base64url');
}

export function fakeField(text: string, keyId: string = TEST_KEY_ID): string {
  return `e2e:v2:${keyId}:${Buffer.from(text.padEnd(120, '.')).toString('base64url')}`;
}

export function fakeEnvelope(fields: { roomId: string; keyId: string; epoch: number; senderId: string; recipientId: string }): string {
  return JSON.stringify({
    v: 2,
    ...fields,
    nonce: randomBytes(24).toString('base64url'),
    box: randomBytes(48).toString('base64url'),
    sig: randomBytes(64).toString('base64url'),
  });
}

export function createIdentity(userId: string): Promise<AssistantIdentity> {
  return buildAssistantIdentity(userId, randomBytes(32));
}

export interface EnvelopeSealing {
  roomId: string;
  keyId: string;
  epoch: number;
  roomKey: Uint8Array;
  sender: AssistantIdentity;
  recipientId: string;
  recipientPublicKey: string;
}

export async function sealEnvelope(sealing: EnvelopeSealing): Promise<string> {
  const sodium = await getSodium();
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const box = sodium.crypto_box_easy(sealing.roomKey, nonce, sodium.from_base64(sealing.recipientPublicKey), sealing.sender.privateKey);
  const unsigned: Omit<RoomKeyEnvelope, 'sig'> = {
    v: 2,
    roomId: sealing.roomId,
    keyId: sealing.keyId,
    epoch: sealing.epoch,
    senderId: sealing.sender.userId,
    recipientId: sealing.recipientId,
    nonce: sodium.to_base64(nonce),
    box: sodium.to_base64(box),
  };
  const header = roomKeySignedHeader({ ...unsigned, sig: '' }, sealing.recipientPublicKey);
  const sig = sodium.to_base64(sodium.crypto_sign_detached(sodium.from_string(header), sealing.sender.signingPrivateKey));
  return JSON.stringify({ ...unsigned, sig });
}

export interface FakeInvite {
  inviteToken: string;
  tokenHash: string;
  encryptedInvite: string;
}

export function fakeInvite(seed: string = randomUUID()): FakeInvite {
  const inviteToken = createHash('sha256').update(`token:${seed}`).digest('base64url');
  return {
    inviteToken,
    tokenHash: createHash('sha256').update(inviteToken).digest('hex'),
    encryptedInvite: createHash('sha256').update(`invite:${seed}`).digest('base64url'),
  };
}

export async function establishFakeGeneration(
  repository: RoomKeyRepository,
  roomId: string,
  senderId: string,
  memberIds: string[],
  keyId: string = TEST_KEY_ID,
  epoch = 1,
): Promise<string> {
  const outcome = await repository.publish({
    mode: 'generation',
    roomId,
    keyId,
    epoch,
    senderId,
    keys: memberIds.map((userId) => ({ userId, sealedKey: fakeEnvelope({ roomId, keyId, epoch, senderId, recipientId: userId }) })),
    invite: fakeInvite(`${roomId}:${keyId}`),
  });
  if (outcome !== 'generation') {
    throw new Error(`generation not stored: ${outcome}`);
  }
  return keyId;
}
