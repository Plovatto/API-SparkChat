import { describe, expect, it } from 'vitest';
import { AiUsageLimiter } from '@/modules/ai/ai.usage-limiter.js';

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
    expect(limiter.getRemaining('user-2')).toBe(50);
  });

  it('reports how many messages are left today', () => {
    const limiter = new AiUsageLimiter();
    limiter.registerUsage('user-1');
    limiter.registerUsage('user-1');

    expect(limiter.getRemaining('user-1')).toBe(48);
  });
});
