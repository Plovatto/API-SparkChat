import { describe, expect, it } from 'vitest';
import { AiRouter, type AiProvider } from '@/modules/ai/ai.provider.js';

function providerThatThrows(message: string): AiProvider {
  return {
    generateReply: () => Promise.reject(new Error(message)),
  };
}

function providerThatReplies(text: string): AiProvider {
  return {
    generateReply: () => Promise.resolve(text),
  };
}

describe('AiRouter', () => {
  it('returns the primary provider reply when it succeeds', async () => {
    const router = new AiRouter([providerThatReplies('primary'), providerThatReplies('fallback')]);
    await expect(router.generateReply([])).resolves.toBe('primary');
  });

  it('falls back to the next provider when the primary fails', async () => {
    const router = new AiRouter([providerThatThrows('quota exceeded'), providerThatReplies('fallback')]);
    await expect(router.generateReply([])).resolves.toBe('fallback');
  });

  it('throws the last error when every provider fails', async () => {
    const router = new AiRouter([providerThatThrows('a'), providerThatThrows('b')]);
    await expect(router.generateReply([])).rejects.toThrow('b');
  });
});
