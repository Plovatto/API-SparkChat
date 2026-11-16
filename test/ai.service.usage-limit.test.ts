import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSodium } from '@/modules/ai/ai.crypto.js';
import type { AssistantIdentity } from '@/modules/ai/ai.identity.js';
import { AI_DAILY_MESSAGE_LIMIT } from '@/modules/ai/ai.model.js';
import { AiRouter } from '@/modules/ai/ai.provider.js';
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
  const { userService, roomService, roomKeyRepository, messageService } = await buildRoomService();
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
  const usageLimiter = new AiUsageLimiter();
  const aiService = new AiService(
    identity,
    roomKeyRepository,
    messageService,
    new TypingService(),
    new RoomPresenceService(),
    new AiRouter([{ generateReply }]),
    usageLimiter,
    new InMemoryObjectStorage(),
  );

  return { aiService, messageService, room, alice, generateReply, usageLimiter };
}

async function listSystemEventTypes(messageService: Awaited<ReturnType<typeof setup>>['messageService'], roomId: string) {
  const { messages } = await messageService.getRoomMessagesPage(roomId, { limit: 100 });
  return messages.filter((message) => message.type === 'error').map((message) => message.systemEvent?.type);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AiService daily usage limit', () => {
  it('counts every message of a batch toward the daily limit', async () => {
    const { aiService, messageService, room, alice, usageLimiter } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const io = createFakeServer();
    for (let index = 0; index < AI_DAILY_MESSAGE_LIMIT - 3; index += 1) {
      usageLimiter.registerUsage(alice.id);
    }

    for (const content of ['um', 'dois', 'três']) {
      const message = await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content });
      aiService.handleIncomingMessage(io, room, message, 'pt');
    }

    expect(usageLimiter.isBlocked(alice.id)).toBe(true);
  });

  it('stops a user who reaches the limit in the middle of a batch and sends the daily limit notice', async () => {
    const { aiService, messageService, room, alice, generateReply, usageLimiter } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const io = createFakeServer();
    for (let index = 0; index < AI_DAILY_MESSAGE_LIMIT - 1; index += 1) {
      usageLimiter.registerUsage(alice.id);
    }

    const allowed = await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content: 'última permitida' });
    aiService.handleIncomingMessage(io, room, allowed, 'pt');
    const blocked = await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content: 'passou do limite' });
    aiService.handleIncomingMessage(io, room, blocked, 'pt');

    await vi.waitFor(async () => {
      expect(await listSystemEventTypes(messageService, room.id)).toEqual(['ai.dailyLimitReached']);
    });

    await vi.advanceTimersByTimeAsync(3000);

    await vi.waitFor(() => {
      expect(generateReply).toHaveBeenCalledTimes(1);
    });
    const [history] = generateReply.mock.calls[0] as unknown as [{ role: string; text?: string }[]];
    expect(history.at(-1)?.text).toBe('última permitida');
  });

  it('does not start a batch once the limit was already reached', async () => {
    const { aiService, messageService, room, alice, generateReply, usageLimiter } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    for (let index = 0; index < AI_DAILY_MESSAGE_LIMIT; index += 1) {
      usageLimiter.registerUsage(alice.id);
    }

    const message = await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content: 'oi' });
    aiService.handleIncomingMessage(createFakeServer(), room, message, 'pt');
    await vi.advanceTimersByTimeAsync(3000);

    await vi.waitFor(async () => {
      expect(await listSystemEventTypes(messageService, room.id)).toEqual(['ai.dailyLimitReached']);
    });
    expect(generateReply).not.toHaveBeenCalled();
  });
});
