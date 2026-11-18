import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptContent, getSodium } from '@/modules/ai/ai.crypto.js';
import type { AssistantIdentity } from '@/modules/ai/ai.identity.js';
import { AI_WELCOME_MESSAGES } from '@/modules/ai/ai.model.js';
import { AiRouter } from '@/modules/ai/ai.provider.js';
import { AI_PENDING_WELCOME_TTL_MS, AiService } from '@/modules/ai/ai.service.js';
import { AiUsageLimiter } from '@/modules/ai/ai.usage-limiter.js';
import { RoomPresenceService, TypingService } from '@/modules/messages/index.js';
import type { AppServer } from '@/sockets/events.js';
import { InMemoryObjectStorage } from '@/storage/object-storage.js';
import { buildRoomService } from './support/build-room-service.js';

const PASSWORD = 'correct-horse-battery-staple';
const PAST_KEY_RETRIES_MS = 5000;

function createFakeServer(): AppServer {
  return { to: () => ({ emit: () => true }) } as unknown as AppServer;
}

async function setup() {
  const services = await buildRoomService();
  const { userService, roomService, roomKeyRepository, messageService } = services;
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
  const publishKey = () => roomKeyRepository.publish(room.id, assistant.id, sodium.to_base64(sodium.crypto_box_seal(roomKey, keyPair.publicKey)));

  const aiService = new AiService(
    identity,
    roomKeyRepository,
    messageService,
    new TypingService(),
    new RoomPresenceService(),
    new AiRouter([{ generateReply: () => Promise.resolve('ok') }]),
    new AiUsageLimiter(),
    new InMemoryObjectStorage(),
  );

  const welcomeTexts = async () => {
    const { messages } = await messageService.getRoomMessagesPage(room.id, { limit: 10 });
    return Promise.all(messages.map((message) => decryptContent(message.content, roomKey)));
  };

  return { aiService, room, publishKey, welcomeTexts };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AiService welcome and the room key', () => {
  it('sends the welcome once the client publishes the room key, when it came after the retries', async () => {
    const { aiService, room, publishKey, welcomeTexts } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const io = createFakeServer();

    const sending = aiService.sendWelcomeMessage(io, room, 'pt');
    await vi.advanceTimersByTimeAsync(PAST_KEY_RETRIES_MS);
    await sending;
    expect(await welcomeTexts()).toEqual([]);

    await publishKey();
    await aiService.handleRoomKeyPublished(io, room);
    expect(await welcomeTexts()).toEqual([AI_WELCOME_MESSAGES.pt]);
  });

  it('sends the pending welcome only once, however many times the key is published', async () => {
    const { aiService, room, publishKey, welcomeTexts } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const io = createFakeServer();

    const sending = aiService.sendWelcomeMessage(io, room, 'en');
    await vi.advanceTimersByTimeAsync(PAST_KEY_RETRIES_MS);
    await sending;
    await publishKey();
    await Promise.all([aiService.handleRoomKeyPublished(io, room), aiService.handleRoomKeyPublished(io, room)]);
    await aiService.handleRoomKeyPublished(io, room);
    expect(await welcomeTexts()).toEqual([AI_WELCOME_MESSAGES.en]);
  });

  it('publishing a key sends nothing when no welcome is waiting', async () => {
    const { aiService, room, publishKey, welcomeTexts } = await setup();
    await publishKey();
    await aiService.sendWelcomeMessage(createFakeServer(), room, 'pt');
    await aiService.handleRoomKeyPublished(createFakeServer(), room);
    expect(await welcomeTexts()).toEqual([AI_WELCOME_MESSAGES.pt]);
  });

  it('forgets a pending welcome after a while', async () => {
    const { aiService, room, publishKey, welcomeTexts } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const io = createFakeServer();

    const sending = aiService.sendWelcomeMessage(io, room, 'pt');
    await vi.advanceTimersByTimeAsync(PAST_KEY_RETRIES_MS);
    await sending;
    await vi.advanceTimersByTimeAsync(AI_PENDING_WELCOME_TTL_MS);
    await publishKey();
    await aiService.handleRoomKeyPublished(io, room);
    expect(await welcomeTexts()).toEqual([]);
  });
});
