import { afterEach, describe, expect, it, vi } from 'vitest';
import { openField } from '@/modules/ai/ai.crypto.js';
import { AI_WELCOME_MESSAGES } from '@/modules/ai/ai.model.js';
import { AI_PENDING_WELCOME_TTL_MS } from '@/modules/ai/ai.service.js';
import { createFakeServer, setupAssistantRoom } from './support/ai-fixture.js';

const PAST_KEY_RETRIES_MS = 5000;

async function setup() {
  const { aiService, room, publishKey, assistantTexts, messageService } = await setupAssistantRoom({ publishKey: false });
  return { aiService, room, publishKey, welcomeTexts: assistantTexts, messageService };
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

  it('a publish that comes before the assistant key keeps the welcome waiting', async () => {
    const { aiService, room, publishKey, welcomeTexts } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const io = createFakeServer();

    const sending = aiService.sendWelcomeMessage(io, room, 'pt');
    await vi.advanceTimersByTimeAsync(PAST_KEY_RETRIES_MS);
    await sending;
    const early = aiService.handleRoomKeyPublished(io, room);
    await vi.advanceTimersByTimeAsync(PAST_KEY_RETRIES_MS);
    await early;
    expect(await welcomeTexts()).toEqual([]);

    await publishKey();
    await aiService.handleRoomKeyPublished(io, room);
    expect(await welcomeTexts()).toEqual([AI_WELCOME_MESSAGES.pt]);
  });

  it('a new welcome replaces a pending one instead of sending both', async () => {
    const { aiService, room, publishKey, welcomeTexts } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const io = createFakeServer();

    const first = aiService.sendWelcomeMessage(io, room, 'pt');
    await vi.advanceTimersByTimeAsync(PAST_KEY_RETRIES_MS);
    await first;
    await publishKey();
    await aiService.sendWelcomeMessage(io, room, 'en');
    await aiService.handleRoomKeyPublished(io, room);
    expect(await welcomeTexts()).toEqual([AI_WELCOME_MESSAGES.en]);
  });

  it('attaches the capabilities card to the welcome', async () => {
    const { aiService, room, assistant, identity, roomKey, messageService } = await setupAssistantRoom();
    await aiService.sendWelcomeMessage(createFakeServer(), room, 'pt');
    const { messages } = await messageService.getRoomMessagesPage(room.id, { limit: 10 });
    const welcome = messages.find((message) => message.senderId === assistant.id);
    const opened = await openField(welcome?.assistantCard ?? '', roomKey, identity.signingPublicKeyBytes, {
      roomId: room.id,
      senderId: assistant.id,
      messageId: welcome?.id ?? '',
      label: 'assistantCard',
    });
    expect(JSON.parse(opened ?? '')).toEqual({ v: 1, kind: 'capabilities' });
  });

  it('a failed delivery is logged and never rejects', async () => {
    const { aiService, room, publishKey, messageService } = await setup();
    vi.spyOn(messageService, 'sendMessage').mockRejectedValue(new Error('db down'));
    await publishKey();
    await expect(aiService.sendWelcomeMessage(createFakeServer(), room, 'pt')).resolves.toBeUndefined();

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const io = createFakeServer();
    const other = await setup();
    vi.spyOn(other.messageService, 'sendMessage').mockRejectedValue(new Error('db down'));
    const sending = other.aiService.sendWelcomeMessage(io, other.room, 'pt');
    await vi.advanceTimersByTimeAsync(PAST_KEY_RETRIES_MS);
    await sending;
    await other.publishKey();
    await expect(other.aiService.handleRoomKeyPublished(io, other.room)).resolves.toBeUndefined();
  });
});
