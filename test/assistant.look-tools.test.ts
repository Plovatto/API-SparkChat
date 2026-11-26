import { describe, expect, it } from 'vitest';
import { AiRouter, type AiGenerateOptions } from '@/modules/ai/ai.provider.js';
import type { AssistantCard } from '@/modules/assistant/assistant.card.js';
import { anotherSuggestionInstruction } from '@/modules/assistant/assistant.prompt.js';
import { QuickReplyRegistry } from '@/modules/assistant/assistant.quick-reply.js';
import { AssistantToolbox, type AssistantContext } from '@/modules/assistant/assistant.toolbox.js';
import { runAssistantTurn } from '@/modules/assistant/assistant.agent.js';
import { LookService } from '@/modules/assistant/look.service.js';
import { registerLookQuickReplies } from '@/modules/assistant/look.quick-reply.js';
import { createApplyLookTool } from '@/modules/assistant/tools/apply-look.tool.js';
import { suggestLookTool } from '@/modules/assistant/tools/suggest-look.tool.js';
import type { AppServer } from '@/sockets/events.js';
import { setupAssistantRoom } from './support/ai-fixture.js';

interface Emitted {
  room: string;
  event: string;
  payload: unknown;
}

function recordingServer(emitted: Emitted[]): AppServer {
  return {
    to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) > 0 }),
  } as unknown as AppServer;
}

async function setup(options: { router?: AiRouter } = {}) {
  const registry = new QuickReplyRegistry();
  let looks: LookService | null = null;
  const context = await setupAssistantRoom({ ...options, quickReplies: registry });
  looks = new LookService(context.userService);
  registerLookQuickReplies(registry, looks);
  const emitted: Emitted[] = [];
  const io = recordingServer(emitted);
  const toolbox = new AssistantToolbox().register(suggestLookTool).register(createApplyLookTool(looks));
  const toolContext = (locale: 'pt' | 'en' = 'pt'): AssistantContext => ({
    io,
    userId: context.alice.id,
    roomId: context.room.id,
    locale,
    timeZone: 'America/Sao_Paulo',
    now: 0,
  });

  async function tap(cardId: string, choice: Parameters<typeof context.sendQuickReplyFromAlice>[0]['choice']) {
    const message = await context.sendQuickReplyFromAlice({ cardId, choice });
    await context.aiService.handleIncomingMessage(io, context.room, message, 'pt');
  }

  async function lastCardMessage() {
    const { messages } = await context.messageService.getRoomMessagesPage(context.room.id, { limit: 50 });
    return messages.filter((message) => message.senderId === context.assistant.id && message.assistantCard).at(-1);
  }

  async function lastAssistantCard(): Promise<AssistantCard | null> {
    const last = await lastCardMessage();
    return last ? ((await context.aiService['openCard'](context.room.id, last)) as AssistantCard | null) : null;
  }

  return { ...context, looks, emitted, io, toolbox, toolContext, tap, lastAssistantCard, lastCardMessage };
}

describe('suggest_look and apply_look tools', () => {
  it('suggest_look returns a look-suggestion card with the three buttons and does not apply', async () => {
    const t = await setup();
    const result = await t.toolbox.run('suggest_look', { colorTheme: 'forest', reason: 'green' }, t.toolContext());
    expect(result.card).toEqual({
      v: 1,
      kind: 'look-suggestion',
      look: { colorTheme: 'forest' },
      buttons: [
        { choice: 'yes', label: 'Aplicar' },
        { choice: 'no', label: 'Não' },
        { choice: 'another', label: 'Outra sugestão' },
      ],
    });
    expect(t.emitted).toEqual([]);
    expect((await t.userService.getUser(t.alice.id))?.theme?.colorTheme).not.toBe('forest');
  });

  it('reports nothing_valid with the rejected ids when everything is invalid', async () => {
    const t = await setup();
    const result = await t.toolbox.run('apply_look', { colorTheme: 'naoExiste', reason: 'x' }, t.toolContext());
    expect(result.response).toEqual({ error: 'nothing_valid', rejected: ['colorTheme:naoExiste'] });
    expect(result.card).toBeUndefined();
    expect(t.emitted).toEqual([]);
  });

  it('apply_look writes, emits both events to the user room and returns look-applied with previous and undo', async () => {
    const t = await setup();
    const result = await t.toolbox.run('apply_look', { colorTheme: 'forest', wallpaper: 'gradient1', reason: 'x' }, t.toolContext('en'));
    expect(result.card).toMatchObject({
      kind: 'look-applied',
      look: { colorTheme: 'forest', wallpaper: 'gradient1' },
      previous: { wallpaper: 'default' },
      buttons: [{ choice: 'undo', label: 'Undo' }],
    });
    expect(t.emitted.map((entry) => [entry.room, entry.event])).toEqual([
      [`user:${t.alice.id}`, 'user:theme-updated'],
      [`user:${t.alice.id}`, 'user:chat-settings-updated'],
    ]);
    expect((await t.userService.getUser(t.alice.id))?.chatSettings?.globalWallpaper).toBe('gradient1');
  });
});

describe('look quick replies', () => {
  const SUGGESTION: AssistantCard = {
    v: 1,
    kind: 'look-suggestion',
    look: { colorTheme: 'forest', wallpaper: 'gradient1' },
    buttons: [
      { choice: 'yes', label: 'Aplicar' },
      { choice: 'no', label: 'Não' },
      { choice: 'another', label: 'Outra sugestão' },
    ],
  };

  it('yes applies the look once even when tapped twice, then undo restores the previous look', async () => {
    const t = await setup();
    const before = await t.looks.currentLook(t.alice.id);
    const card = await t.sendCardFromAssistant(SUGGESTION);

    await t.tap(card.id, 'yes');
    await t.tap(card.id, 'yes');

    const texts = await t.assistantTexts();
    expect(texts.filter((text) => text?.startsWith('Pronto!'))).toHaveLength(1);
    expect(texts.at(-1)).toContain('o papel de parede Oceano');
    expect(t.emitted.filter((entry) => entry.event === 'user:theme-updated')).toHaveLength(1);
    const applied = await t.lastAssistantCard();
    expect(applied).toMatchObject({ kind: 'look-applied', look: SUGGESTION.kind === 'look-suggestion' ? SUGGESTION.look : null });

    const appliedMessage = await t.lastCardMessage();
    await t.tap(appliedMessage?.id as string, 'undo');
    expect(await t.looks.currentLook(t.alice.id)).toEqual(before);
    expect((await t.assistantTexts()).at(-1)).toMatch(/^Desfeito!/);
  });

  it('no answers with Sem problemas! and a choices card, and keep only answers Combinado!', async () => {
    const t = await setup();
    const card = await t.sendCardFromAssistant(SUGGESTION);

    await t.tap(card.id, 'no');
    expect((await t.assistantTexts()).at(-1)).toBe('Sem problemas!');
    const choices = await t.lastAssistantCard();
    expect(choices).toEqual({
      v: 1,
      kind: 'choices',
      buttons: [
        { choice: 'another', label: 'Outra sugestão' },
        { choice: 'keep', label: 'Deixa assim' },
      ],
    });
    expect(t.emitted).toEqual(expect.not.arrayContaining([expect.objectContaining({ event: 'user:theme-updated' })]));

    const choicesMessage = await t.lastCardMessage();
    await t.tap(choicesMessage?.id as string, 'keep');
    expect((await t.assistantTexts()).at(-1)).toBe('Combinado!');
    expect(await t.lastAssistantCard()).toEqual(choices);
  });

  it('another asks the model for a different look and tells it the previous one', async () => {
    const seen: AiGenerateOptions[] = [];
    const router = new AiRouter([
      {
        generate: (_messages, options) => {
          seen.push(options);
          return Promise.resolve({ text: 'que tal este?', calls: [] });
        },
      },
    ]);
    const t = await setup({ router });
    const card = await t.sendCardFromAssistant(SUGGESTION);
    await t.tap(card.id, 'another');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen[0]?.systemInstruction).toContain('diferente do cartão anterior');
    expect(seen[0]?.systemInstruction).toContain('"colorTheme":"forest"');
  });
});

describe('prompt', () => {
  it('includes the catalog summary only when look tools are registered', async () => {
    const seen: string[] = [];
    const router = new AiRouter([
      {
        generate: (_messages, options) => {
          seen.push(options.systemInstruction);
          return Promise.resolve({ text: 'ok', calls: [] });
        },
      },
    ]);
    const context: AssistantContext = { io: {} as never, userId: 'u', roomId: 'r', locale: 'pt', timeZone: 'America/Sao_Paulo', now: 0 };
    const looks = new LookService({} as never);
    const withLooks = new AssistantToolbox().register(suggestLookTool).register(createApplyLookTool(looks));
    await runAssistantTurn({ history: [], locale: 'pt', context, toolbox: withLooks, router });
    await runAssistantTurn({ history: [], locale: 'pt', context, toolbox: new AssistantToolbox(), router });
    expect(seen[0]).toContain('Catálogo de visuais');
    expect(seen[0]).toContain('forest|Floresta');
    expect(seen[1]).not.toContain('Catálogo de visuais');
  });

  it('anotherSuggestionInstruction carries the previous look and falls back to the base text for other cards', () => {
    const suggestion: AssistantCard = { v: 1, kind: 'look-suggestion', look: { colorTheme: 'sunset' }, buttons: [] };
    expect(anotherSuggestionInstruction('en', suggestion)).toContain('"colorTheme":"sunset"');
    expect(anotherSuggestionInstruction('en', { v: 1, kind: 'choices', buttons: [] })).not.toContain('previous look was');
  });
});
