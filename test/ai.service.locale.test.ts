import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_WELCOME_MESSAGES } from '@/modules/ai/ai.model.js';
import { AiRouter, type AiGenerateOptions } from '@/modules/ai/ai.provider.js';
import { createFakeServer, setupAssistantRoom } from './support/ai-fixture.js';

async function setup() {
  const receivedOptions: AiGenerateOptions[] = [];
  const router = new AiRouter([
    {
      generate: (_messages, options) => {
        receivedOptions.push(options);
        return Promise.resolve({ text: 'ok', calls: [] });
      },
    },
  ]);
  const context = await setupAssistantRoom({ router });
  return { ...context, receivedOptions };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AiService locale', () => {
  it.each(['pt', 'en'] as const)('sends the welcome message in %s', async (locale) => {
    const { aiService, messageService, room, openFromAssistant } = await setup();

    await aiService.sendWelcomeMessage(createFakeServer(), room, locale);

    const { messages } = await messageService.getRoomMessagesPage(room.id, { limit: 10 });
    expect(messages).toHaveLength(1);
    const [welcome] = messages;
    expect(welcome?.content.startsWith('e2e:v2:')).toBe(true);
    await expect(welcome ? openFromAssistant(welcome) : null).resolves.toBe(AI_WELCOME_MESSAGES[locale]);
  });

  it('asks the model to reply in the locale of the connection that sent the message', async () => {
    const { aiService, room, receivedOptions, sendFromAlice } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });

    const message = await sendFromAlice('hello there');
    await aiService.handleIncomingMessage(createFakeServer(), room, message, 'en');
    await vi.advanceTimersByTimeAsync(3000);

    await vi.waitFor(() => {
      expect(receivedOptions).toEqual([{ locale: 'en' }]);
    });
  });

  it('uses the locale of the latest message when a batch mixes connections', async () => {
    const { aiService, room, receivedOptions, sendFromAlice } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const io = createFakeServer();

    const first = await sendFromAlice('oi');
    await aiService.handleIncomingMessage(io, room, first, 'pt');
    const second = await sendFromAlice('hello');
    await aiService.handleIncomingMessage(io, room, second, 'en');
    await vi.advanceTimersByTimeAsync(3000);

    await vi.waitFor(() => {
      expect(receivedOptions).toEqual([{ locale: 'en' }]);
    });
  });
});
