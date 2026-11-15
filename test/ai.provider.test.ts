import { describe, expect, it } from 'vitest';
import { AiRouter, type AiProvider, type AiReplyOptions } from '@/modules/ai/ai.provider.js';

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
    await expect(router.generateReply([], { locale: 'pt' })).resolves.toBe('primary');
  });

  it('falls back to the next provider when the primary fails', async () => {
    const router = new AiRouter([providerThatThrows('quota exceeded'), providerThatReplies('fallback')]);
    await expect(router.generateReply([], { locale: 'pt' })).resolves.toBe('fallback');
  });

  it('forwards the reply options to the provider', async () => {
    const received: AiReplyOptions[] = [];
    const router = new AiRouter([
      {
        generateReply: (_messages, options) => {
          received.push(options);
          return Promise.resolve('ok');
        },
      },
    ]);

    await router.generateReply([], { locale: 'en' });

    expect(received).toEqual([{ locale: 'en' }]);
  });

  it('throws the last error when every provider fails', async () => {
    const router = new AiRouter([providerThatThrows('a'), providerThatThrows('b')]);
    await expect(router.generateReply([], { locale: 'pt' })).rejects.toThrow('b');
  });
});
