import { randomUUID } from 'node:crypto';
import { ASSISTANT_USER_ID, hashPassword, hashToken, type RoomRotationNotice, type UserRecord, type UserRepository } from '../users/index.js';
import { deriveSigningKeyPair, getSodium, signIdentityBinding } from './ai.crypto.js';
import { ASSISTANT_AVATAR, ASSISTANT_NICKNAME, ASSISTANT_NICKNAME_NORMALIZED, ASSISTANT_STATUS_TEXT } from './ai.model.js';

export interface AssistantIdentity {
  userId: string;
  publicKey: string;
  publicKeyBytes: Uint8Array;
  privateKey: Uint8Array;
  signingPublicKey: string;
  signingPublicKeyBytes: Uint8Array;
  signingPrivateKey: Uint8Array;
  keySignature: string;
}

const PRIVATE_KEY_BYTES = 32;

export async function loadAssistantIdentity(privateKeyBase64: string): Promise<AssistantIdentity> {
  const sodium = await getSodium();
  const privateKey = sodium.from_base64(privateKeyBase64);

  if (privateKey.length !== PRIVATE_KEY_BYTES) {
    throw new Error(`AI_ASSISTANT_PRIVATE_KEY deve decodificar para ${PRIVATE_KEY_BYTES} bytes.`);
  }

  return buildAssistantIdentity(ASSISTANT_USER_ID, privateKey);
}

export async function buildAssistantIdentity(userId: string, privateKey: Uint8Array): Promise<AssistantIdentity> {
  const sodium = await getSodium();
  const publicKeyBytes = sodium.crypto_scalarmult_base(privateKey);
  const publicKey = sodium.to_base64(publicKeyBytes);
  const signing = await deriveSigningKeyPair(privateKey);
  const keySignature = await signIdentityBinding(userId, publicKey, signing.privateKey);

  return {
    userId,
    publicKey,
    publicKeyBytes,
    privateKey,
    signingPublicKey: sodium.to_base64(signing.publicKey),
    signingPublicKeyBytes: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    keySignature,
  };
}

function needsUpdate(existing: UserRecord, identity: AssistantIdentity): boolean {
  return (
    existing.e2ePublicKey !== identity.publicKey ||
    existing.e2eSigningPublicKey !== identity.signingPublicKey ||
    existing.e2eKeySignature !== identity.keySignature ||
    existing.status !== 'online' ||
    existing.statusText !== ASSISTANT_STATUS_TEXT
  );
}

export async function ensureAssistantUser(userRepository: UserRepository, identity: AssistantIdentity): Promise<RoomRotationNotice[]> {
  const now = new Date().toISOString();
  const existing = await userRepository.findById(identity.userId);

  if (!existing) {
    await userRepository.insert({
      id: identity.userId,
      nickname: ASSISTANT_NICKNAME,
      nicknameNormalized: ASSISTANT_NICKNAME_NORMALIZED,
      avatar: ASSISTANT_AVATAR,
      passwordHash: await hashPassword(randomUUID()),
      recoveryTokenHash: hashToken(randomUUID()),
      status: 'online',
      statusText: ASSISTANT_STATUS_TEXT,
      createdAt: now,
      lastSeen: now,
      e2ePublicKey: identity.publicKey,
      e2eSigningPublicKey: identity.signingPublicKey,
      e2eKeySignature: identity.keySignature,
    });
    return [];
  }

  if (!needsUpdate(existing, identity)) {
    return [];
  }

  const patch = {
    e2ePublicKey: identity.publicKey,
    e2eSigningPublicKey: identity.signingPublicKey,
    e2eKeySignature: identity.keySignature,
    status: 'online' as const,
    statusText: ASSISTANT_STATUS_TEXT,
    lastSeen: now,
  };
  if (existing.e2ePublicKey && existing.e2ePublicKey !== identity.publicKey) {
    return userRepository.updateIdentityRequiringRotation(identity.userId, patch);
  }

  await userRepository.update(identity.userId, patch);
  return [];
}
