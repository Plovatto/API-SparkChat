import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_DAILY_MESSAGE_LIMIT } from '@/modules/ai/ai.model.js';
import { AiRouter } from '@/modules/ai/ai.provider.js';
import { AiUsageLimiter } from '@/modules/ai/ai.usage-limiter.js';
import { createFakeServer, setupAssistantRoom } from './support/ai-fixture.js';

async function setup() {
  const generateReply = vi.fn(() => Promise.resolve('ok'));
  const usageLimiter = new AiUsageLimiter();
  const context = await setupAssistantRoom({ router: new AiRouter([{ generateReply }]), usageLimiter });
  return { ...context, generateReply, usageLimiter };
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
    const { aiService, room, alice, usageLimiter, sendFromAlice } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const io = createFakeServer();
    for (let index = 0; index < AI_DAILY_MESSAGE_LIMIT - 3; index += 1) {
      usageLimiter.registerUsage(alice.id);
    }

    for (const content of ['um', 'dois', 'três']) {
      const message = await sendFromAlice(content);
      aiService.handleIncomingMessage(io, room, message, 'pt');
    }

    expect(usageLimiter.isBlocked(alice.id)).toBe(true);
  });

  it('stops a user who reaches the limit in the middle of a batch and sends the daily limit notice', async () => {
    const { aiService, messageService, room, alice, generateReply, usageLimiter, sendFromAlice } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const io = createFakeServer();
    for (let index = 0; index < AI_DAILY_MESSAGE_LIMIT - 1; index += 1) {
      usageLimiter.registerUsage(alice.id);
    }

    const allowed = await sendFromAlice('última permitida');
    aiService.handleIncomingMessage(io, room, allowed, 'pt');
    const blocked = await sendFromAlice('passou do limite');
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
    const { aiService, messageService, room, alice, generateReply, usageLimiter, sendFromAlice } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    for (let index = 0; index < AI_DAILY_MESSAGE_LIMIT; index += 1) {
      usageLimiter.registerUsage(alice.id);
    }

    const message = await sendFromAlice('oi');
    aiService.handleIncomingMessage(createFakeServer(), room, message, 'pt');
    await vi.advanceTimersByTimeAsync(3000);

    await vi.waitFor(async () => {
      expect(await listSystemEventTypes(messageService, room.id)).toEqual(['ai.dailyLimitReached']);
    });
    expect(generateReply).not.toHaveBeenCalled();
  });
});
