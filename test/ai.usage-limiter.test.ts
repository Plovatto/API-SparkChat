import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiUsageLimiter } from '@/modules/ai/ai.usage-limiter.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('AiUsageLimiter', () => {
  it('allows usage until the daily limit is reached', () => {
    const limiter = new AiUsageLimiter();
    const userId = 'user-1';

    for (let i = 0; i < 50; i += 1) {
      expect(limiter.isBlocked(userId)).toBe(false);
      limiter.registerUsage(userId);
    }

    expect(limiter.isBlocked(userId)).toBe(true);
  });

  it('tracks usage independently per user', () => {
    const limiter = new AiUsageLimiter();
    limiter.registerUsage('user-1');

    expect(limiter.isBlocked('user-1')).toBe(false);
    expect(limiter.isBlocked('user-2')).toBe(false);
  });

  it('resets the count once the day changes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T23:59:00.000Z'));

    const limiter = new AiUsageLimiter();
    for (let i = 0; i < 50; i += 1) {
      limiter.registerUsage('user-1');
    }
    expect(limiter.isBlocked('user-1')).toBe(true);

    vi.setSystemTime(new Date('2026-01-02T00:01:00.000Z'));

    expect(limiter.isBlocked('user-1')).toBe(false);
  });
});
