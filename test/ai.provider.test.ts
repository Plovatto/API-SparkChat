import { describe, expect, it } from 'vitest';
import { AiRouter, type AiProvider, type AiGenerateOptions } from '@/modules/ai/ai.provider.js';

const OPTIONS: AiGenerateOptions = { locale: 'pt', systemInstruction: 'sys', tools: [] };

function providerThatThrows(message: string): AiProvider {
  return {
    generate: () => Promise.reject(new Error(message)),
  };
}

function providerThatReplies(text: string): AiProvider {
  return {
    generate: () => Promise.resolve({ text, calls: [] }),
  };
}

describe('AiRouter', () => {
  it('returns the primary provider reply when it succeeds', async () => {
    const router = new AiRouter([providerThatReplies('primary'), providerThatReplies('fallback')]);
    await expect(router.generate([], OPTIONS)).resolves.toEqual({ text: 'primary', calls: [] });
  });

  it('falls back to the next provider when the primary fails', async () => {
    const router = new AiRouter([providerThatThrows('quota exceeded'), providerThatReplies('fallback')]);
    await expect(router.generate([], OPTIONS)).resolves.toEqual({ text: 'fallback', calls: [] });
  });

  it('forwards the reply options to the provider', async () => {
    const received: AiGenerateOptions[] = [];
    const router = new AiRouter([
      {
        generate: (_messages, options) => {
          received.push(options);
          return Promise.resolve({ text: 'ok', calls: [] });
        },
      },
    ]);

    await router.generate([], { ...OPTIONS, locale: 'en' });

    expect(received).toEqual([{ ...OPTIONS, locale: 'en' }]);
  });

  it('throws the last error when every provider fails', async () => {
    const router = new AiRouter([providerThatThrows('a'), providerThatThrows('b')]);
    await expect(router.generate([], OPTIONS)).rejects.toThrow('b');
  });
});

describe('AiRouter tool calls', () => {
  it('returns tool calls and falls back when the first provider fails', async () => {
    const calls = [{ id: 'c1', name: 'echo', args: { a: 1 } }];
    const router = new AiRouter([providerThatThrows('x'), { generate: () => Promise.resolve({ text: '', calls }) }]);
    await expect(router.generate([], OPTIONS)).resolves.toEqual({ text: '', calls });
  });
});
