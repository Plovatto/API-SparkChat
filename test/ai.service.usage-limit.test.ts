import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiRouter } from '@/modules/ai/ai.provider.js';
import { AiUsageLimiter, AiUsageRepository } from '@/modules/ai/ai.usage-limiter.js';
import { createFakeServer, setupAssistantRoom } from './support/ai-fixture.js';
import { createTestDb } from './support/create-test-db.js';

const TEST_DAILY_LIMIT = 4;

async function setup() {
  const generate = vi.fn(() => Promise.resolve({ text: 'ok', calls: [] }));
  const usageLimiter = new AiUsageLimiter(new AiUsageRepository(await createTestDb()), TEST_DAILY_LIMIT);
  const context = await setupAssistantRoom({ router: new AiRouter([{ generate }]), usageLimiter });
  return { ...context, generate, usageLimiter };
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
    for (let index = 0; index < TEST_DAILY_LIMIT - 3; index += 1) {
      await usageLimiter.tryConsume(alice.id);
    }

    for (const content of ['um', 'dois', 'três']) {
      const message = await sendFromAlice(content);
      await aiService.handleIncomingMessage(io, room, message, 'pt');
    }

    await vi.waitFor(async () => {
      expect(await usageLimiter.isBlocked(alice.id)).toBe(true);
    });
  });

  it('stops a user who reaches the limit in the middle of a batch and sends the daily limit notice', async () => {
    const { aiService, messageService, room, alice, generate, usageLimiter, sendFromAlice } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const io = createFakeServer();
    for (let index = 0; index < TEST_DAILY_LIMIT - 1; index += 1) {
      await usageLimiter.tryConsume(alice.id);
    }

    const allowed = await sendFromAlice('última permitida');
    await aiService.handleIncomingMessage(io, room, allowed, 'pt');
    const blocked = await sendFromAlice('passou do limite');
    await aiService.handleIncomingMessage(io, room, blocked, 'pt');

    await vi.waitFor(async () => {
      expect(await listSystemEventTypes(messageService, room.id)).toEqual(['ai.dailyLimitReached']);
    });

    await vi.advanceTimersByTimeAsync(3000);

    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(1);
    });
    const [history] = generate.mock.calls[0] as unknown as [{ role: string; text?: string }[]];
    expect(history.at(-1)?.text).toBe('última permitida');
  });

  it('does not start a batch once the limit was already reached', async () => {
    const { aiService, messageService, room, alice, generate, usageLimiter, sendFromAlice } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    for (let index = 0; index < TEST_DAILY_LIMIT; index += 1) {
      await usageLimiter.tryConsume(alice.id);
    }

    const message = await sendFromAlice('oi');
    await aiService.handleIncomingMessage(createFakeServer(), room, message, 'pt');
    await vi.advanceTimersByTimeAsync(3000);

    await vi.waitFor(async () => {
      expect(await listSystemEventTypes(messageService, room.id)).toEqual(['ai.dailyLimitReached']);
    });
    expect(generate).not.toHaveBeenCalled();
  });
});
