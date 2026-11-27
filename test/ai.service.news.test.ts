import { describe, expect, it, vi } from 'vitest';
import { AI_NEWS_MESSAGES, AI_WELCOME_MESSAGES } from '@/modules/ai/ai.model.js';
import { ASSISTANT_NEWS_VERSION } from '@/modules/users/index.js';
import { TEST_V2_SIGNUP } from './support/test-constants.js';
import { createFakeServer, setupAssistantRoom, type EmittedEvent } from './support/ai-fixture.js';

async function setupExisting(options: Parameters<typeof setupAssistantRoom>[0] = {}) {
  const setup = await setupAssistantRoom(options);
  await setup.userRepository.releaseAssistantNews(setup.alice.id, ASSISTANT_NEWS_VERSION, null);
  return setup;
}

describe('AiService what is new message', () => {
  it('sends the news once to an existing user, even with concurrent connections', async () => {
    const { aiService, alice, assistantTexts, userRepository } = await setupExisting();
    const emitted: EmittedEvent[] = [];
    const io = createFakeServer(emitted);

    await Promise.all([aiService.deliverNewsIfDue(io, alice.id, 'pt'), aiService.deliverNewsIfDue(io, alice.id, 'pt')]);
    await aiService.deliverNewsIfDue(io, alice.id, 'pt');

    expect(await assistantTexts()).toEqual([AI_NEWS_MESSAGES.pt]);
    expect(emitted.filter((event) => event.event === 'message:new')).toHaveLength(1);
    expect(await userRepository.getAssistantNewsVersion(alice.id)).toBe(ASSISTANT_NEWS_VERSION);
  });

  it('uses the connection locale', async () => {
    const { aiService, alice, assistantTexts } = await setupExisting();
    await aiService.deliverNewsIfDue(createFakeServer(), alice.id, 'en');
    expect(await assistantTexts()).toEqual([AI_NEWS_MESSAGES.en]);
  });

  it('sends nothing to a user who got the welcome', async () => {
    const { aiService, alice, room, assistantTexts } = await setupAssistantRoom();
    await aiService.sendWelcomeMessage(createFakeServer(), room, 'pt');
    await aiService.deliverNewsIfDue(createFakeServer(), alice.id, 'pt');
    expect(await assistantTexts()).toEqual([AI_WELCOME_MESSAGES.pt]);
  });

  it('does not claim without a room key and delivers on a later connection', async () => {
    const { aiService, alice, publishKey, assistantTexts, userRepository } = await setupExisting({ publishKey: false });
    await aiService.deliverNewsIfDue(createFakeServer(), alice.id, 'pt');
    expect(await assistantTexts()).toEqual([]);
    expect(await userRepository.getAssistantNewsVersion(alice.id)).toBeNull();

    await publishKey();
    await aiService.deliverNewsIfDue(createFakeServer(), alice.id, 'pt');
    expect(await assistantTexts()).toEqual([AI_NEWS_MESSAGES.pt]);
  });

  it('sends nothing when the version is already current', async () => {
    const { aiService, alice, assistantTexts, userRepository } = await setupExisting();
    await userRepository.claimAssistantNews(alice.id, ASSISTANT_NEWS_VERSION);
    await aiService.deliverNewsIfDue(createFakeServer(), alice.id, 'pt');
    expect(await assistantTexts()).toEqual([]);
  });

  it('releases the claim when sending fails so a later connection delivers', async () => {
    const { aiService, alice, assistantTexts, messageService, userRepository } = await setupExisting();
    const failing = vi.spyOn(messageService, 'sendMessage').mockRejectedValueOnce(new Error('db down'));
    await expect(aiService.deliverNewsIfDue(createFakeServer(), alice.id, 'pt')).resolves.toBeUndefined();
    expect(await userRepository.getAssistantNewsVersion(alice.id)).toBeNull();

    failing.mockRestore();
    await aiService.deliverNewsIfDue(createFakeServer(), alice.id, 'pt');
    expect(await assistantTexts()).toEqual([AI_NEWS_MESSAGES.pt]);
  });

  it('a freshly registered user connecting before the welcome gets no news', async () => {
    const { aiService, alice, assistantTexts } = await setupAssistantRoom();
    await aiService.deliverNewsIfDue(createFakeServer(), alice.id, 'pt');
    expect(await assistantTexts()).toEqual([]);
  });

  it('sends nothing to a user without a SparkAI room', async () => {
    const { aiService, userService, assistantTexts } = await setupAssistantRoom();
    const { user: stranger } = await userService.registerAccount({ nickname: 'Bob', avatar: 2, password: 'correct-horse-battery-staple-0123456789abcd', ...TEST_V2_SIGNUP });
    await aiService.deliverNewsIfDue(createFakeServer(), stranger.id, 'pt');
    expect(await assistantTexts()).toEqual([]);
  });
});
