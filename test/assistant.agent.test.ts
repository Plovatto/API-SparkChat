import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiRouter, type AiConversationMessage, type AiGenerateOptions, type AiTurn } from '@/modules/ai/ai.provider.js';
import { runAssistantTurn } from '@/modules/assistant/assistant.agent.js';
import type { AssistantCard } from '@/modules/assistant/assistant.card.js';
import { AssistantToolbox, defineTool, type AssistantContext } from '@/modules/assistant/assistant.toolbox.js';

const CONTEXT: AssistantContext = { userId: 'u', roomId: 'r', locale: 'pt', io: {} as never, timeZone: 'America/Sao_Paulo', now: Date.UTC(2026, 10, 27, 12, 0) };
const CARD: AssistantCard = { v: 1, kind: 'capabilities' };
const CHOICES: AssistantCard = { v: 1, kind: 'choices', buttons: [{ choice: 'yes', label: 'Sim' }] };

function scripted(turns: AiTurn[]) {
  const seen: { messages: AiConversationMessage[]; options: AiGenerateOptions }[] = [];
  const router = new AiRouter([
    {
      generate: (messages, options) => {
        seen.push({ messages: [...messages], options });
        return Promise.resolve(turns[Math.min(seen.length - 1, turns.length - 1)] as AiTurn);
      },
    },
  ]);
  return { router, seen };
}

function echoToolbox() {
  const toolbox = new AssistantToolbox();
  const ran: unknown[] = [];
  toolbox.register(
    defineTool({
      declaration: { name: 'echo', description: 'echo', parameters: { type: 'object' } },
      schema: z.object({ value: z.string() }),
      run: (args) => {
        ran.push(args);
        return Promise.resolve({ response: { echoed: args.value } });
      },
    }),
  );
  return { toolbox, ran };
}

const call = (id: string, args: Record<string, unknown> = { value: 'hi' }) => ({ id, name: 'echo', args });

describe('runAssistantTurn', () => {
  it('runs a tool, feeds the function response back and returns the final text', async () => {
    const { router, seen } = scripted([
      { text: '', calls: [call('c1')] },
      { text: 'pronto', calls: [] },
    ]);
    const { toolbox, ran } = echoToolbox();

    const reply = await runAssistantTurn({ history: [{ role: 'user', text: 'oi' }], locale: 'pt', context: CONTEXT, toolbox, router });

    expect(reply).toEqual({ text: 'pronto', card: null });
    expect(ran).toEqual([{ value: 'hi' }]);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.options.tools.map((tool) => tool.name)).toEqual(['echo']);
    expect(seen[0]?.options.systemInstruction).toContain('2026-11-27T09:00');
    const second = seen[1]?.messages ?? [];
    expect(second.at(-2)).toMatchObject({ role: 'model', functionCall: [{ id: 'c1', name: 'echo' }] });
    expect(second.at(-1)).toEqual({ role: 'user', functionResponse: [{ id: 'c1', name: 'echo', response: { echoed: 'hi' } }] });
  });

  it('stops after 3 rounds when the model keeps calling tools', async () => {
    const { router, seen } = scripted([{ text: 'ainda', calls: [call('c')] }]);
    const { toolbox, ran } = echoToolbox();

    const reply = await runAssistantTurn({ history: [], locale: 'pt', context: CONTEXT, toolbox, router });

    expect(seen).toHaveLength(3);
    expect(ran).toHaveLength(3);
    expect(reply.text).toBe('ainda');
  });

  it('executes at most 5 tool calls per turn across rounds and answers the rest with too_many_calls', async () => {
    const { router, seen } = scripted([
      { text: '', calls: [call('a'), call('b'), call('c'), call('d')] },
      { text: '', calls: [call('e'), call('f'), call('g')] },
      { text: 'fim', calls: [] },
    ]);
    const { toolbox, ran } = echoToolbox();

    const reply = await runAssistantTurn({ history: [], locale: 'pt', context: CONTEXT, toolbox, router });

    expect(ran).toHaveLength(5);
    expect(reply.text).toBe('fim');
    expect(seen[2]?.messages.at(-1)).toEqual({
      role: 'user',
      functionResponse: [
        { id: 'e', name: 'echo', response: { echoed: 'hi' } },
        { id: 'f', name: 'echo', response: { error: 'too_many_calls' } },
        { id: 'g', name: 'echo', response: { error: 'too_many_calls' } },
      ],
    });
  });

  it('answers invalid args with invalid_args without throwing', async () => {
    const { router, seen } = scripted([
      { text: '', calls: [call('c1', { value: 5 })] },
      { text: 'ok', calls: [] },
    ]);
    const { toolbox, ran } = echoToolbox();

    const reply = await runAssistantTurn({ history: [], locale: 'pt', context: CONTEXT, toolbox, router });

    expect(ran).toEqual([]);
    expect(reply.text).toBe('ok');
    expect(seen[1]?.messages.at(-1)).toEqual({ role: 'user', functionResponse: [{ id: 'c1', name: 'echo', response: { error: 'invalid_args' } }] });
  });

  it('keeps the last card returned by tools', async () => {
    const { router } = scripted([
      { text: '', calls: [call('a')] },
      { text: '', calls: [call('b')] },
      { text: 'fim', calls: [] },
    ]);
    const toolbox = new AssistantToolbox();
    let runs = 0;
    toolbox.register(
      defineTool({
        declaration: { name: 'echo', description: 'echo' },
        schema: z.object({ value: z.string() }),
        run: () => {
          runs += 1;
          return Promise.resolve({ response: {}, card: runs === 1 ? CARD : CHOICES });
        },
      }),
    );

    const reply = await runAssistantTurn({ history: [], locale: 'pt', context: CONTEXT, toolbox, router });

    expect(reply).toEqual({ text: 'fim', card: CHOICES });
  });

  it('turns a throwing tool into tool_failed and keeps going', async () => {
    const { router, seen } = scripted([
      { text: '', calls: [call('c1')] },
      { text: 'desculpa', calls: [] },
    ]);
    const toolbox = new AssistantToolbox();
    toolbox.register(
      defineTool({
        declaration: { name: 'echo', description: 'echo' },
        schema: z.object({ value: z.string() }),
        run: () => Promise.reject(new Error('boom')),
      }),
    );

    const reply = await runAssistantTurn({ history: [], locale: 'pt', context: CONTEXT, toolbox, router });

    expect(reply.text).toBe('desculpa');
    expect(seen[1]?.messages.at(-1)).toEqual({ role: 'user', functionResponse: [{ id: 'c1', name: 'echo', response: { error: 'tool_failed' } }] });
  });

  it.each([
    ['pt', 'Pronto! ✨', 'Não consegui concluir agora, tenta de novo?'],
    ['en', 'Done! ✨', "I couldn't finish that right now, try again?"],
  ] as const)('never returns empty text in %s', async (locale, done, gaveUp) => {
    const withCard = scripted([
      { text: '', calls: [call('c1')] },
      { text: '', calls: [] },
    ]);
    const cardToolbox = new AssistantToolbox();
    cardToolbox.register(
      defineTool({
        declaration: { name: 'echo', description: 'echo' },
        schema: z.object({ value: z.string() }),
        run: () => Promise.resolve({ response: {}, card: CARD }),
      }),
    );
    await expect(runAssistantTurn({ history: [], locale, context: CONTEXT, toolbox: cardToolbox, router: withCard.router })).resolves.toEqual({ text: done, card: CARD });

    const exhausted = scripted([{ text: '', calls: [call('c')] }]);
    const { toolbox } = echoToolbox();
    await expect(runAssistantTurn({ history: [], locale, context: CONTEXT, toolbox, router: exhausted.router })).resolves.toEqual({ text: gaveUp, card: null });
  });

  describe('claim guard', () => {
    function noteToolbox() {
      const toolbox = new AssistantToolbox();
      const saved: unknown[] = [];
      toolbox.register(
        defineTool({
          declaration: { name: 'save_note', description: 'n', parameters: { type: 'object' } },
          schema: z.object({ text: z.string() }),
          run: (args) => {
            saved.push(args);
            return Promise.resolve({ response: { saved: true } });
          },
        }),
      );
      return { toolbox, saved };
    }

    it('retries once with forced function calling when the model claims an action without calling a tool', async () => {
      const { router, seen } = scripted([
        { text: 'Anotado!', calls: [] },
        { text: '', calls: [{ id: 's1', name: 'save_note', args: { text: 'leite' } }] },
        { text: 'Guardei sua nota.', calls: [] },
      ]);
      const { toolbox, saved } = noteToolbox();
      const reply = await runAssistantTurn({ history: [{ role: 'user', text: 'anota comprar leite' }], locale: 'pt', context: CONTEXT, toolbox, router });

      expect(saved).toEqual([{ text: 'leite' }]);
      expect(reply.text).toBe('Guardei sua nota.');
      expect(seen[0]?.options.toolConfig).toBeUndefined();
      expect(seen[1]?.options.toolConfig).toEqual({ mode: 'ANY', allowedFunctionNames: ['save_note'] });
      expect(seen[2]?.options.toolConfig).toBeUndefined();
    });

    it('triggers on a claim in the reply even when the request looks like small talk', async () => {
      const toolbox = new AssistantToolbox();
      const ran: string[] = [];
      toolbox.register(
        defineTool({
          declaration: { name: 'suggest_look', description: 's', parameters: { type: 'object' } },
          schema: z.object({}),
          run: () => {
            ran.push('suggest_look');
            return Promise.resolve({ response: {} });
          },
        }),
      );
      const { router } = scripted([
        { text: 'Apliquei o tema!', calls: [] },
        { text: '', calls: [{ id: 's1', name: 'suggest_look', args: {} }] },
        { text: 'ok', calls: [] },
      ]);
      await runAssistantTurn({ history: [{ role: 'user', text: 'oi, tudo bem?' }], locale: 'pt', context: CONTEXT, toolbox, router });
      expect(ran).toEqual(['suggest_look']);
    });

    it.each([
      'você lembra o nome daquele filme?',
      'qual o tema da festa?',
      'that reminds me of a song',
      "let's set a time to talk",
      'mudamos de assunto',
      'como está seu status hoje?',
    ])('does not trigger for small talk: %s', async (text) => {
      const { router, seen } = scripted([{ text: 'Claro, conversa vai.', calls: [] }]);
      const { toolbox } = noteToolbox();
      await runAssistantTurn({ history: [{ role: 'user', text }], locale: 'pt', context: CONTEXT, toolbox, router });
      expect(seen).toHaveLength(1);
    });

    it('does not push an empty model turn before the forced retry', async () => {
      const { router, seen } = scripted([
        { text: '', calls: [] },
        { text: '', calls: [{ id: 's1', name: 'save_note', args: { text: 'x' } }] },
        { text: 'ok', calls: [] },
      ]);
      const { toolbox } = noteToolbox();
      await runAssistantTurn({ history: [{ role: 'user', text: 'anota x' }], locale: 'pt', context: CONTEXT, toolbox, router });
      expect(seen[1]?.messages.some((message) => message.role === 'model' && !message.text && !message.functionCall)).toBe(false);
      expect(seen[1]?.messages).toHaveLength(1);
    });

    it('keeps save_note out of the forced retry without note intent', async () => {
      const { router, seen } = scripted([{ text: 'Anotei!', calls: [] }, { text: 'ok', calls: [] }]);
      const { toolbox } = noteToolbox();
      await runAssistantTurn({ history: [{ role: 'user', text: 'oi' }], locale: 'pt', context: CONTEXT, toolbox, router });
      expect(seen).toHaveLength(1);
    });

    it('sends the nudge only in the system instruction', async () => {
      const { router, seen } = scripted([{ text: 'Anotado!', calls: [] }, { text: 'ok', calls: [] }]);
      const { toolbox } = noteToolbox();
      await runAssistantTurn({ history: [{ role: 'user', text: 'anota x' }], locale: 'pt', context: CONTEXT, toolbox, router });
      expect(seen[1]?.options.systemInstruction).toContain('Atenção');
      expect(seen[1]?.messages.filter((message) => message.text?.includes('Atenção'))).toHaveLength(0);
    });

    it('does not trigger for a generic status question', async () => {
      const { router, seen } = scripted([{ text: 'Tudo certo por aqui.', calls: [] }]);
      const { toolbox } = noteToolbox();
      await runAssistantTurn({ history: [{ role: 'user', text: 'como está seu status hoje?' }], locale: 'pt', context: CONTEXT, toolbox, router });
      expect(seen).toHaveLength(1);
    });

    it('keeps apply_look out of the forced retry for a suggestion request', async () => {
      const toolbox = new AssistantToolbox();
      for (const name of ['suggest_look', 'apply_look']) {
        toolbox.register(defineTool({ declaration: { name, description: name, parameters: { type: 'object' } }, schema: z.object({}), run: () => Promise.resolve({ response: {} }) }));
      }
      const { router, seen } = scripted([{ text: 'Aqui está um tema!', calls: [] }, { text: 'ok', calls: [] }]);
      await runAssistantTurn({ history: [{ role: 'user', text: 'sugere um tema' }], locale: 'pt', context: CONTEXT, toolbox, router });
      expect(seen[1]?.options.toolConfig?.allowedFunctionNames).toEqual(['suggest_look']);

      const picked = scripted([{ text: 'Apliquei!', calls: [] }, { text: 'ok', calls: [] }]);
      await runAssistantTurn({ history: [{ role: 'user', text: 'escolhe um tema pra mim' }], locale: 'pt', context: CONTEXT, toolbox, router: picked.router });
      expect(picked.seen[1]?.options.toolConfig?.allowedFunctionNames).toEqual(['suggest_look', 'apply_look']);
    });

    it('does not trigger when a tool was already called in the turn', async () => {
      const { router, seen } = scripted([
        { text: '', calls: [{ id: 's1', name: 'save_note', args: { text: 'x' } }] },
        { text: 'Anotado!', calls: [] },
      ]);
      const { toolbox } = noteToolbox();
      await runAssistantTurn({ history: [{ role: 'user', text: 'anota x' }], locale: 'pt', context: CONTEXT, toolbox, router });
      expect(seen).toHaveLength(2);
    });
  });

  it('reports an unknown tool to the model', async () => {
    const toolbox = new AssistantToolbox();
    await expect(toolbox.run('nope', {}, CONTEXT)).resolves.toEqual({ response: { error: 'unknown_tool' } });
  });
});
