import { randomUUID } from 'node:crypto';
import { ASSISTANT_USER_ID, hashPassword, hashToken, type UserRecord, type UserRepository } from '../users/index.js';
import { getSodium } from './ai.crypto.js';
import { ASSISTANT_AVATAR, ASSISTANT_NICKNAME, ASSISTANT_NICKNAME_NORMALIZED, ASSISTANT_STATUS_TEXT } from './ai.model.js';

export interface AssistantIdentity {
  userId: string;
  publicKey: string;
  publicKeyBytes: Uint8Array;
  privateKey: Uint8Array;
}

const PRIVATE_KEY_BYTES = 32;

export async function loadAssistantIdentity(privateKeyBase64: string): Promise<AssistantIdentity> {
  const sodium = await getSodium();
  const privateKey = sodium.from_base64(privateKeyBase64);

  if (privateKey.length !== PRIVATE_KEY_BYTES) {
    throw new Error(`AI_ASSISTANT_PRIVATE_KEY deve decodificar para ${PRIVATE_KEY_BYTES} bytes.`);
  }

  const publicKeyBytes = sodium.crypto_scalarmult_base(privateKey);
  const publicKey = sodium.to_base64(publicKeyBytes);

  return { userId: ASSISTANT_USER_ID, publicKey, publicKeyBytes, privateKey };
}

function needsUpdate(existing: UserRecord, identity: AssistantIdentity): boolean {
  return (
    existing.e2ePublicKey !== identity.publicKey ||
    existing.status !== 'online' ||
    existing.statusText !== ASSISTANT_STATUS_TEXT
  );
}

export async function ensureAssistantUser(userRepository: UserRepository, identity: AssistantIdentity): Promise<void> {
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
      socketId: '',
      status: 'online',
      statusText: ASSISTANT_STATUS_TEXT,
      createdAt: now,
      lastSeen: now,
      e2ePublicKey: identity.publicKey,
    });
    return;
  }

  if (needsUpdate(existing, identity)) {
    await userRepository.update(identity.userId, {
      e2ePublicKey: identity.publicKey,
      status: 'online',
      statusText: ASSISTANT_STATUS_TEXT,
      lastSeen: now,
    });
  }
}
