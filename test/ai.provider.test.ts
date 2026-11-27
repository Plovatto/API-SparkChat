import { describe, expect, it } from 'vitest';
import { ApiError, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import {
  AiRouter,
  GeminiModelProvider,
  type AiConversationMessage,
  type AiGenerateOptions,
  type AiProvider,
} from '@/modules/ai/ai.provider.js';

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

describe('GeminiModelProvider tools-less safety net', () => {
  const TOOLS: AiGenerateOptions = {
    locale: 'pt',
    systemInstruction: 'sys',
    tools: [{ name: 'echo', description: 'd', parameters: { type: 'object' } }],
  };
  const HISTORY: AiConversationMessage[] = [
    { role: 'user', text: 'oi' },
    { role: 'model', functionCall: [{ id: 'c1', name: 'echo', args: {} }] },
    { role: 'user', functionResponse: [{ id: 'c1', name: 'echo', response: { ok: true } }] },
  ];

  function fakeClient(handler: (params: GenerateContentParameters) => Promise<unknown>) {
    const calls: GenerateContentParameters[] = [];
    const client = {
      models: {
        generateContent: (params: GenerateContentParameters) => {
          calls.push(params);
          return handler(params) as Promise<GenerateContentResponse>;
        },
      },
    };
    return { client, calls };
  }

  const textResponse = (text: string) => ({ text, functionCalls: undefined, candidates: [{ content: { parts: [{ text }] } }] });

  it('retries without tools and function parts after a 400 and returns plain text', async () => {
    const { client, calls } = fakeClient((params) =>
      params.config?.tools ? Promise.reject(new ApiError({ message: 'bad schema', status: 400 })) : Promise.resolve(textResponse('plain')),
    );
    const turn = await new GeminiModelProvider(client, 'm').generate(HISTORY, TOOLS);

    expect(turn).toEqual({ text: 'plain', calls: [] });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.config?.tools).toBeUndefined();
    expect(JSON.stringify(calls[1]?.contents)).not.toContain('functionCall');
    expect(JSON.stringify(calls[1]?.contents)).not.toContain('functionResponse');
  });

  it('passes the tool config as function calling config and drops it on the tools-less retry', async () => {
    const { client, calls } = fakeClient(() => Promise.resolve(textResponse('ok')));
    await new GeminiModelProvider(client, 'm').generate(HISTORY, { ...TOOLS, toolConfig: { mode: 'ANY', allowedFunctionNames: ['echo'] } });

    expect(calls[0]?.config?.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['echo'] } });

    const failing = fakeClient((params) =>
      params.config?.tools ? Promise.reject(new ApiError({ message: 'bad', status: 400 })) : Promise.resolve(textResponse('plain')),
    );
    await new GeminiModelProvider(failing.client, 'm').generate(HISTORY, { ...TOOLS, toolConfig: { mode: 'ANY' } });
    expect(failing.calls[1]?.config?.toolConfig).toBeUndefined();
  });

  it('retries without tools when the finish reason is MALFORMED_FUNCTION_CALL', async () => {
    const { client, calls } = fakeClient((params) =>
      params.config?.tools
        ? Promise.resolve({ text: undefined, functionCalls: undefined, candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] })
        : Promise.resolve(textResponse('plain')),
    );
    await expect(new GeminiModelProvider(client, 'm').generate(HISTORY, TOOLS)).resolves.toEqual({ text: 'plain', calls: [] });
    expect(calls).toHaveLength(2);
  });

  it.each([401, 403, 429, 500])('does not retry without tools on status %i', async (status) => {
    const { client, calls } = fakeClient(() => Promise.reject(new ApiError({ message: 'x', status })));
    await expect(new GeminiModelProvider(client, 'm').generate(HISTORY, TOOLS)).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });

  it('does not retry when no tools were sent', async () => {
    const { client, calls } = fakeClient(() => Promise.reject(new ApiError({ message: 'x', status: 400 })));
    await expect(new GeminiModelProvider(client, 'm').generate([], { ...TOOLS, tools: [] })).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });

  it('leaves the success path untouched', async () => {
    const { client, calls } = fakeClient(() => Promise.resolve(textResponse('hi')));
    await expect(new GeminiModelProvider(client, 'm').generate(HISTORY, TOOLS)).resolves.toEqual({ text: 'hi', calls: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.config?.tools).toBeDefined();
  });
});
