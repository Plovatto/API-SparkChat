import { randomUUID } from 'node:crypto';
import { deriveKeyId, getSodium, openField, sealField } from '@/modules/ai/ai.crypto.js';
import { AiRouter } from '@/modules/ai/ai.provider.js';
import { AiService } from '@/modules/ai/ai.service.js';
import { AiUsageLimiter, AiUsageRepository } from '@/modules/ai/ai.usage-limiter.js';
import { RoomPresenceService, TypingService, type MessageRecord } from '@/modules/messages/index.js';
import type { AssistantToolbox } from '@/modules/assistant/assistant.toolbox.js';
import type { AppServer } from '@/sockets/events.js';
import { buildRoomService } from './build-room-service.js';
import { createIdentity, sealAttachmentBytes, sealEnvelope } from './room-keys.js';
import { TEST_V2_SIGNUP } from './test-constants.js';

const PASSWORD = 'correct-horse-battery-staple-0123456789abcd';

export function createFakeServer(): AppServer {
  return { to: () => ({ emit: () => true }) } as unknown as AppServer;
}

export interface AssistantRoomOptions {
  router?: AiRouter;
  usageLimiter?: AiUsageLimiter;
  publishKey?: boolean;
  toolbox?: AssistantToolbox;
}

export async function setupAssistantRoom(options: AssistantRoomOptions = {}) {
  const services = await buildRoomService();
  const { userService, userRepository, roomService, roomKeyRepository, messageService, objectStorage } = services;
  const sodium = await getSodium();

  const { user: alice } = await userService.registerAccount({ nickname: 'Alice', avatar: 0, password: PASSWORD, ...TEST_V2_SIGNUP });
  const { user: assistant } = await userService.registerAccount({ nickname: 'Assistente', avatar: 1, password: PASSWORD, ...TEST_V2_SIGNUP });
  const aliceIdentity = await createIdentity(alice.id);
  const identity = await createIdentity(assistant.id);
  for (const party of [aliceIdentity, identity]) {
    await userRepository.update(party.userId, {
      e2ePublicKey: party.publicKey,
      e2eSigningPublicKey: party.signingPublicKey,
      e2eKeySignature: party.keySignature,
    });
  }

  const room = await roomService.createPrivateRoom(alice.id, assistant.id);
  const roomKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const keyId = await deriveKeyId(roomKey);

  async function publishKey(): Promise<void> {
    const envelope = (recipientId: string, recipientPublicKey: string) =>
      sealEnvelope({ roomId: room.id, keyId, epoch: 1, roomKey, sender: aliceIdentity, recipientId, recipientPublicKey });
    const outcome = await roomKeyRepository.publish({
      mode: 'generation',
      roomId: room.id,
      keyId,
      epoch: 1,
      senderId: alice.id,
      keys: [
        { userId: alice.id, sealedKey: await envelope(alice.id, aliceIdentity.publicKey) },
        { userId: assistant.id, sealedKey: await envelope(assistant.id, identity.publicKey) },
      ],
    });
    if (outcome !== 'generation') {
      throw new Error(`assistant room key not stored: ${outcome}`);
    }
  }

  if (options.publishKey !== false) {
    await publishKey();
  }

  function sealFromAlice(text: string, messageId: string, label = 'content'): Promise<string> {
    return sealField(text, roomKey, keyId, aliceIdentity.signingPrivateKey, { roomId: room.id, senderId: alice.id, messageId, label });
  }

  async function storeSealedAttachment(objectKey: string, plaintext: Buffer, messageId: string): Promise<{ url: string; key: string; rawKey: string }> {
    const sealed = await sealAttachmentBytes(plaintext, { roomId: room.id, messageId, slot: 'content' });
    const url = await services.storeUpload(alice.id, objectKey, sealed.bytes);
    return { url: `${url}?e2e=1`, key: await sealFromAlice(sealed.fileKey, messageId, 'file-key'), rawKey: sealed.fileKey };
  }

  async function sendFromAlice(text: string): Promise<MessageRecord> {
    const messageId = randomUUID();
    return messageService.sendMessage({ roomId: room.id, senderId: alice.id, messageId, content: await sealFromAlice(text, messageId) });
  }

  function openFromAssistant(message: MessageRecord): Promise<string | null> {
    return openField(message.content, roomKey, identity.signingPublicKeyBytes, {
      roomId: room.id,
      senderId: assistant.id,
      messageId: message.id,
      label: 'content',
    });
  }

  async function assistantTexts(): Promise<(string | null)[]> {
    const { messages } = await messageService.getRoomMessagesPage(room.id, { limit: 50 });
    return Promise.all(messages.filter((message) => message.senderId === assistant.id && message.type === 'text').map(openFromAssistant));
  }

  const aiService = new AiService(
    identity,
    roomKeyRepository,
    messageService,
    new TypingService(),
    new RoomPresenceService(),
    options.router ?? new AiRouter([{ generate: () => Promise.resolve({ text: 'ok', calls: [] }) }]),
    options.usageLimiter ?? new AiUsageLimiter(new AiUsageRepository(services.db)),
    objectStorage,
    userService,
    options.toolbox,
  );

  return {
    ...services,
    aiService,
    alice,
    aliceIdentity,
    assistant,
    identity,
    room,
    roomKey,
    keyId,
    publishKey,
    sealFromAlice,
    sendFromAlice,
    storeSealedAttachment,
    openFromAssistant,
    assistantTexts,
  };
}
