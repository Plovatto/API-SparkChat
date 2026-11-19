import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptContent, getSodium } from '@/modules/ai/ai.crypto.js';
import type { AssistantIdentity } from '@/modules/ai/ai.identity.js';
import { AiRouter } from '@/modules/ai/ai.provider.js';
import { AiService } from '@/modules/ai/ai.service.js';
import { AiUsageLimiter } from '@/modules/ai/ai.usage-limiter.js';
import { RoomPresenceService, TypingService } from '@/modules/messages/index.js';
import type { AppServer } from '@/sockets/events.js';
import { buildRoomService } from './support/build-room-service.js';

const PASSWORD = 'correct-horse-battery-staple';

function createFakeServer(): AppServer {
  return { to: () => ({ emit: () => true }) } as unknown as AppServer;
}

async function setup() {
  const services = await buildRoomService();
  const { userService, roomService, roomKeyRepository, messageService, objectStorage } = services;
  const sodium = await getSodium();

  const { user: alice } = await userService.registerAccount({ nickname: 'Alice', avatar: 0, password: PASSWORD });
  const { user: assistant } = await userService.registerAccount({ nickname: 'Assistente', avatar: 1, password: PASSWORD });
  const keyPair = sodium.crypto_box_keypair();
  const identity: AssistantIdentity = {
    userId: assistant.id,
    publicKey: sodium.to_base64(keyPair.publicKey),
    publicKeyBytes: keyPair.publicKey,
    privateKey: keyPair.privateKey,
  };

  const room = await roomService.createPrivateRoom(alice.id, assistant.id);
  const roomKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  await roomKeyRepository.publish(room.id, assistant.id, sodium.to_base64(sodium.crypto_box_seal(roomKey, keyPair.publicKey)));

  const generateReply = vi.fn(() => Promise.resolve('ok'));
  const aiService = new AiService(
    identity,
    roomKeyRepository,
    messageService,
    new TypingService(),
    new RoomPresenceService(),
    new AiRouter([{ generateReply }]),
    new AiUsageLimiter(),
    objectStorage,
  );

  async function storeEncryptedAudio(key: string): Promise<string> {
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const sealed = sodium.crypto_secretbox_easy(Buffer.from('voice bytes'), nonce, roomKey);
    const url = await services.storeUpload(alice.id, key, Buffer.concat([Buffer.from(nonce), Buffer.from(sealed)]));
    return `${url}?e2e=1`;
  }

  return { aiService, messageService, room, alice, roomKey, generateReply, storeEncryptedAudio };
}

async function lastInlineMimeType(generateReply: ReturnType<typeof vi.fn>): Promise<string | undefined> {
  await vi.advanceTimersByTimeAsync(3000);
  await vi.waitFor(() => {
    expect(generateReply).toHaveBeenCalledTimes(1);
  });
  const [history] = generateReply.mock.calls[0] as unknown as [{ inlineData?: { mimeType: string }[] }[]];
  return history.at(-1)?.inlineData?.[0]?.mimeType;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AiService audio attachments', () => {
  it('takes the audio type from the encrypted file metadata when the url has no extension', async () => {
    const { aiService, messageService, room, alice, roomKey, generateReply, storeEncryptedAudio } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const content = await storeEncryptedAudio('uploads/audio/voice.bin');

    const message = await messageService.sendMessage({
      roomId: room.id,
      senderId: alice.id,
      content,
      type: 'audio',
      duration: 3,
      fileMeta: { name: await encryptContent('audio-1', roomKey), mimeType: await encryptContent('audio/ogg;codecs=opus', roomKey), size: 11 },
    });
    aiService.handleIncomingMessage(createFakeServer(), room, message, 'pt');

    expect(await lastInlineMimeType(generateReply)).toBe('audio/ogg');
  });

  it('falls back to the url extension for older audio messages without file metadata', async () => {
    const { aiService, messageService, room, alice, generateReply, storeEncryptedAudio } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const content = await storeEncryptedAudio('uploads/audio/legacy.webm');

    const message = await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content, type: 'audio', duration: 3 });
    aiService.handleIncomingMessage(createFakeServer(), room, message, 'pt');

    expect(await lastInlineMimeType(generateReply)).toBe('audio/webm');
  });
});
