import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptContent, getSodium } from '@/modules/ai/ai.crypto.js';
import type { AssistantIdentity } from '@/modules/ai/ai.identity.js';
import { AI_WELCOME_MESSAGES } from '@/modules/ai/ai.model.js';
import { AiRouter, type AiReplyOptions } from '@/modules/ai/ai.provider.js';
import { AiService } from '@/modules/ai/ai.service.js';
import { AiUsageLimiter } from '@/modules/ai/ai.usage-limiter.js';
import { RoomPresenceService, TypingService } from '@/modules/messages/index.js';
import type { AppServer } from '@/sockets/events.js';
import { InMemoryObjectStorage } from '@/storage/object-storage.js';
import { buildRoomService } from './support/build-room-service.js';

const PASSWORD = 'correct-horse-battery-staple';

function createFakeServer(): AppServer {
  return { to: () => ({ emit: () => true }) } as unknown as AppServer;
}

async function setup() {
  const services = await buildRoomService();
  const { userService, roomService, roomKeyRepository, messageService } = services;
  const sodium = await getSodium();

  const { user: alice } = await userService.registerAccount({ nickname: 'Alice', avatar: 0, password: PASSWORD, socketId: 's-alice' });
  const { user: assistant } = await userService.registerAccount({ nickname: 'Assistente', avatar: 1, password: PASSWORD, socketId: 's-ai' });
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

  const receivedOptions: AiReplyOptions[] = [];
  const router = new AiRouter([
    {
      generateReply: (_messages, options) => {
        receivedOptions.push(options);
        return Promise.resolve('ok');
      },
    },
  ]);

  const aiService = new AiService(
    identity,
    roomKeyRepository,
    messageService,
    new TypingService(),
    new RoomPresenceService(),
    router,
    new AiUsageLimiter(),
    new InMemoryObjectStorage(),
  );

  return { aiService, messageService, room, roomKey, alice, receivedOptions };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AiService locale', () => {
  it.each(['pt', 'en'] as const)('sends the welcome message in %s', async (locale) => {
    const { aiService, messageService, room, roomKey } = await setup();

    await aiService.sendWelcomeMessage(createFakeServer(), room, locale);

    const { messages } = await messageService.getRoomMessagesPage(room.id, { limit: 10 });
    expect(messages).toHaveLength(1);
    await expect(decryptContent(messages[0]?.content ?? '', roomKey)).resolves.toBe(AI_WELCOME_MESSAGES[locale]);
  });

  it('asks the model to reply in the locale of the connection that sent the message', async () => {
    const { aiService, messageService, room, alice, receivedOptions } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });

    const message = await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content: 'hello there' });
    aiService.handleIncomingMessage(createFakeServer(), room, message, 'en');
    await vi.advanceTimersByTimeAsync(3000);

    await vi.waitFor(() => {
      expect(receivedOptions).toEqual([{ locale: 'en' }]);
    });
  });

  it('uses the locale of the latest message when a batch mixes connections', async () => {
    const { aiService, messageService, room, alice, receivedOptions } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const io = createFakeServer();

    const first = await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content: 'oi' });
    aiService.handleIncomingMessage(io, room, first, 'pt');
    const second = await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content: 'hello' });
    aiService.handleIncomingMessage(io, room, second, 'en');
    await vi.advanceTimersByTimeAsync(3000);

    await vi.waitFor(() => {
      expect(receivedOptions).toEqual([{ locale: 'en' }]);
    });
  });
});
