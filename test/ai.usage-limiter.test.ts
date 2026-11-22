import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiUsageLimiter, AiUsageRepository } from '@/modules/ai/ai.usage-limiter.js';
import { createTestDb } from './support/create-test-db.js';

afterEach(() => {
  vi.useRealTimers();
});

async function createLimiter() {
  const repository = new AiUsageRepository(await createTestDb());
  return { repository, limiter: new AiUsageLimiter(repository) };
}

describe('AiUsageLimiter', () => {
  it('allows usage until the daily limit is reached', async () => {
    const { limiter } = await createLimiter();
    const userId = 'user-1';

    for (let i = 0; i < 50; i += 1) {
      expect(await limiter.isBlocked(userId)).toBe(false);
      expect(await limiter.tryConsume(userId)).toBe(true);
    }

    expect(await limiter.isBlocked(userId)).toBe(true);
    expect(await limiter.tryConsume(userId)).toBe(false);
  });

  it('tracks usage independently per user', async () => {
    const { limiter } = await createLimiter();
    await limiter.tryConsume('user-1');

    expect(await limiter.isBlocked('user-1')).toBe(false);
    expect(await limiter.isBlocked('user-2')).toBe(false);
  });

  it('resets the count once the day changes', async () => {
    const { limiter } = await createLimiter();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T23:59:00.000Z'));

    for (let i = 0; i < 50; i += 1) {
      await limiter.tryConsume('user-1');
    }
    expect(await limiter.isBlocked('user-1')).toBe(true);

    vi.setSystemTime(new Date('2026-01-02T00:01:00.000Z'));

    expect(await limiter.isBlocked('user-1')).toBe(false);
  });

  it('keeps the count across restarts and instances that share the database', async () => {
    const { repository, limiter } = await createLimiter();
    for (let i = 0; i < 50; i += 1) {
      await limiter.tryConsume('user-1');
    }

    const afterRestart = new AiUsageLimiter(repository);

    expect(await afterRestart.isBlocked('user-1')).toBe(true);
    expect(await afterRestart.tryConsume('user-1')).toBe(false);
  });

  it('never lets concurrent consumers go past the limit', async () => {
    const { repository } = await createLimiter();
    const instances = [new AiUsageLimiter(repository), new AiUsageLimiter(repository)];

    const results = await Promise.all(Array.from({ length: 80 }, (_, index) => instances[index % 2]!.tryConsume('user-1')));

    expect(results.filter(Boolean)).toHaveLength(50);
  });

  it('purges counters from previous days', async () => {
    const { repository, limiter } = await createLimiter();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    for (let i = 0; i < 50; i += 1) {
      await limiter.tryConsume('user-1');
    }

    await repository.purgeBefore('2026-01-02');
    vi.setSystemTime(new Date('2026-01-01T13:00:00.000Z'));

    expect(await limiter.isBlocked('user-1')).toBe(false);
  });
});
