import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiRouter } from '@/modules/ai/ai.provider.js';
import type { AssistantCard } from '@/modules/assistant/assistant.card.js';
import { QuickReplyRegistry } from '@/modules/assistant/assistant.quick-reply.js';
import { AssistantToolbox, defineTool } from '@/modules/assistant/assistant.toolbox.js';
import { createFakeServer, setupAssistantRoom, type EmittedEvent } from './support/ai-fixture.js';

const CARD: AssistantCard = {
  v: 1,
  kind: 'confirm',
  action: { type: 'delete-note', noteId: 'n1', preview: 'x' },
  buttons: [
    { choice: 'yes', label: 'Sim' },
    { choice: 'no', label: 'Não' },
  ],
};

const SUGGESTION: AssistantCard = { v: 1, kind: 'look-suggestion', look: {}, buttons: [{ choice: 'another', label: 'Outra' }] };

function lookToolbox() {
  return new AssistantToolbox().register(
    defineTool({
      declaration: { name: 'suggest_look', description: 'suggest', parameters: { type: 'object' } },
      schema: z.object({}),
      run: () => Promise.resolve({ response: { ok: true }, card: SUGGESTION }),
    }),
  );
}

function suggestingGenerate() {
  return vi
    .fn()
    .mockResolvedValueOnce({ text: '', calls: [{ id: 'c1', name: 'suggest_look', args: {} }] })
    .mockResolvedValue({ text: 'que tal este?', calls: [] });
}

afterEach(() => {
  vi.useRealTimers();
});

async function setup(options: Parameters<typeof setupAssistantRoom>[0] = {}) {
  const registry = new QuickReplyRegistry();
  const handler = vi.fn().mockResolvedValue({ text: 'feito', card: null });
  registry.registerQuickReplyHandler('confirm', handler);
  const context = await setupAssistantRoom({ ...options, quickReplies: registry });
  const emitted: EmittedEvent[] = [];
  return { ...context, registry, handler, emitted, io: createFakeServer(emitted) };
}

describe('assistant quick replies', () => {
  it('runs the handler once for two sequential taps and replies immediately', async () => {
    const t = await setup();
    const card = await t.sendCardFromAssistant(CARD);

    for (let i = 0; i < 2; i += 1) {
      const tap = await t.sendQuickReplyFromAlice({ cardId: card.id, choice: 'yes' });
      await t.aiService.handleIncomingMessage(t.io, t.room, tap, 'pt');
    }

    expect(t.handler).toHaveBeenCalledTimes(1);
    expect(t.handler.mock.calls[0]?.[0]).toMatchObject({ userId: t.alice.id, choice: 'yes', card: CARD });
    expect(await t.assistantTexts()).toContain('feito');
    const resolved = t.emitted.filter((entry) => entry.event === 'message:card-resolved');
    expect(resolved).toEqual([{ event: 'message:card-resolved', payload: { roomId: t.room.id, cardId: card.id, choice: 'yes' } }]);
  });

  it('runs the handler once for concurrent taps', async () => {
    const t = await setup();
    const card = await t.sendCardFromAssistant(CARD);
    const taps = await Promise.all([
      t.sendQuickReplyFromAlice({ cardId: card.id, choice: 'yes' }),
      t.sendQuickReplyFromAlice({ cardId: card.id, choice: 'no' }),
    ]);

    await Promise.all(taps.map((tap) => t.aiService.handleIncomingMessage(t.io, t.room, tap, 'pt')));

    expect(t.handler).toHaveBeenCalledTimes(1);
    expect(await t.messageService.isCardResolved(card.id)).toBe(true);
  });

  it('ignores cards from other rooms and from non-assistant senders', async () => {
    const t = await setup();
    const own = await t.sendFromAlice('oi');
    const other = await setup();
    const foreign = await other.sendCardFromAssistant(CARD);

    for (const cardId of [own.id, foreign.id]) {
      const tap = await t.sendQuickReplyFromAlice({ cardId, choice: 'yes' });
      await t.aiService.handleIncomingMessage(t.io, t.room, tap, 'pt');
    }

    expect(t.handler).not.toHaveBeenCalled();
    expect(await t.messageService.isCardResolved(own.id)).toBe(false);
    expect(t.emitted.filter((entry) => entry.event === 'message:card-resolved')).toHaveLength(0);
  });

  it('resolves silently when no handler is registered for the kind', async () => {
    const t = await setup();
    const card = await t.sendCardFromAssistant({ v: 1, kind: 'choices', buttons: [{ choice: 'keep', label: 'Manter' }] });
    const before = (await t.assistantTexts()).length;

    await t.aiService.handleIncomingMessage(t.io, t.room, await t.sendQuickReplyFromAlice({ cardId: card.id, choice: 'keep' }), 'pt');

    expect(await t.messageService.isCardResolved(card.id)).toBe(true);
    expect(await t.assistantTexts()).toHaveLength(before);
  });

  it('exposes resolvedChoice in history views once resolved', async () => {
    const t = await setup();
    const card = await t.sendCardFromAssistant(CARD);
    const unresolved = await t.messageService.toViews([card]);
    expect(unresolved[0]?.resolvedChoice).toBeUndefined();

    await t.aiService.handleIncomingMessage(t.io, t.room, await t.sendQuickReplyFromAlice({ cardId: card.id, choice: 'no' }), 'pt');

    const { messages } = await t.messageService.getRoomMessagesPage(t.room.id, { limit: 20 });
    const views = await t.messageService.toViews(messages);
    expect(views.find((view) => view.id === card.id)?.resolvedChoice).toBe('no');
    expect((await t.messageService.toView(card)).resolvedChoice).toBe('no');
  });

  it('asks the model for a different suggestion on another, consuming the daily limit', async () => {
    const generate = suggestingGenerate();
    const tryConsume = vi.fn().mockResolvedValue(true);
    const t = await setup({ toolbox: lookToolbox(), router: new AiRouter([{ generate }]), usageLimiter: { tryConsume } as never });
    const card = await t.sendCardFromAssistant({ v: 1, kind: 'look-suggestion', look: {}, buttons: [{ choice: 'another', label: 'Outra' }] });

    await t.aiService.handleIncomingMessage(t.io, t.room, await t.sendQuickReplyFromAlice({ cardId: card.id, choice: 'another' }), 'pt');

    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2), { timeout: 10000 });
    const options = generate.mock.calls[0]?.[1] as { systemInstruction: string };
    expect(options.systemInstruction).toContain('outra sugestão');
    expect(generate.mock.calls[0]?.[1]).toMatchObject({ toolConfig: { mode: 'ANY', allowedFunctionNames: ['suggest_look'] } });
    expect(tryConsume).toHaveBeenCalledTimes(1);
    expect(t.handler).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect(await t.assistantTexts()).toContain('que tal este?'), { timeout: 10000 });
  });

  it('replies with the limit message on another when the daily limit is reached', async () => {
    const generate = vi.fn().mockResolvedValue({ text: 'x', calls: [] });
    const t = await setup({ router: new AiRouter([{ generate }]), usageLimiter: { tryConsume: vi.fn().mockResolvedValue(false) } as never });
    const card = await t.sendCardFromAssistant({ v: 1, kind: 'look-suggestion', look: {}, buttons: [{ choice: 'another', label: 'Outra' }] });

    await t.aiService.handleIncomingMessage(t.io, t.room, await t.sendQuickReplyFromAlice({ cardId: card.id, choice: 'another' }), 'pt');

    const { messages } = await t.messageService.getRoomMessagesPage(t.room.id, { limit: 20 });
    expect(messages.some((message) => message.type === 'error' && message.systemEvent?.type === 'ai.dailyLimitReached')).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    const views = await t.messageService.toViews(messages);
    expect(views.find((view) => view.id === card.id)?.resolvedChoice).toBeUndefined();
    expect(t.emitted.some((event) => event.event === 'message:card-resolved')).toBe(false);
  });

  it('announces the resolution of another only after the suggestion succeeds', async () => {
    const generate = suggestingGenerate();
    const t = await setup({ toolbox: lookToolbox(), router: new AiRouter([{ generate }]), usageLimiter: { tryConsume: vi.fn().mockResolvedValue(true), refund: vi.fn().mockResolvedValue(undefined) } as never });
    const card = await t.sendCardFromAssistant({ v: 1, kind: 'look-suggestion', look: {}, buttons: [{ choice: 'another', label: 'Outra' }] });

    await t.aiService.handleIncomingMessage(t.io, t.room, await t.sendQuickReplyFromAlice({ cardId: card.id, choice: 'another' }), 'pt');

    await vi.waitFor(() => expect(t.emitted.some((event) => event.event === 'message:card-resolved')).toBe(true), { timeout: 10000 });
    expect((await t.messageService.toView(card)).resolvedChoice).toBe('another');
  });

  it('releases the card when another produces no new suggestion card', async () => {
    const generate = vi.fn().mockResolvedValue({ text: 'Aqui está outra opção!', calls: [] });
    const t = await setup({ toolbox: lookToolbox(), router: new AiRouter([{ generate }]), usageLimiter: { tryConsume: vi.fn().mockResolvedValue(true), refund: vi.fn().mockResolvedValue(undefined) } as never });
    const card = await t.sendCardFromAssistant({ v: 1, kind: 'look-suggestion', look: {}, buttons: [{ choice: 'another', label: 'Outra' }] });

    await t.aiService.handleIncomingMessage(t.io, t.room, await t.sendQuickReplyFromAlice({ cardId: card.id, choice: 'another' }), 'pt');

    await vi.waitFor(() => expect(generate).toHaveBeenCalled(), { timeout: 10000 });
    await vi.waitFor(async () => expect((await t.messageService.toView(card)).resolvedChoice).toBeUndefined(), { timeout: 10000 });
    expect(t.emitted.some((event) => event.event === 'message:card-resolved')).toBe(false);
    expect(await t.assistantTexts()).not.toContain('Aqui está outra opção!');
  });

  it('releases the card when generating another suggestion fails', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('boom'));
    const refund = vi.fn().mockResolvedValue(undefined);
    const t = await setup({ router: new AiRouter([{ generate }]), usageLimiter: { tryConsume: vi.fn().mockResolvedValue(true), refund } as never });
    const card = await t.sendCardFromAssistant({ v: 1, kind: 'look-suggestion', look: {}, buttons: [{ choice: 'another', label: 'Outra' }] });

    await t.aiService.handleIncomingMessage(t.io, t.room, await t.sendQuickReplyFromAlice({ cardId: card.id, choice: 'another' }), 'pt');

    await vi.waitFor(() => expect(generate).toHaveBeenCalled(), { timeout: 10000 });
    await vi.waitFor(async () => expect((await t.messageService.toView(card)).resolvedChoice).toBeUndefined(), { timeout: 10000 });
    expect(t.emitted.some((event) => event.event === 'message:card-resolved')).toBe(false);
    await vi.waitFor(() => expect(refund).toHaveBeenCalledWith(t.alice.id), { timeout: 10000 });
  });

  it('rejects a choice the card does not offer without writing a resolution', async () => {
    const t = await setup();
    const noOnly = await t.sendCardFromAssistant({ ...CARD, buttons: [{ choice: 'no', label: 'Não' }] });
    const capabilities = await t.sendCardFromAssistant({ v: 1, kind: 'capabilities' });
    const list = await t.sendCardFromAssistant({ v: 1, kind: 'list', title: 't', items: [] });

    for (const cardId of [noOnly.id, capabilities.id, list.id]) {
      await t.aiService.handleIncomingMessage(t.io, t.room, await t.sendQuickReplyFromAlice({ cardId, choice: 'yes' }), 'pt');
      expect(await t.messageService.isCardResolved(cardId)).toBe(false);
    }
    expect(t.handler).not.toHaveBeenCalled();
    expect(t.emitted.filter((entry) => entry.event === 'message:card-resolved')).toHaveLength(0);
  });

  it('sends a localized error and releases the button when the handler throws', async () => {
    const t = await setup();
    t.handler.mockRejectedValueOnce(new Error('boom'));
    const card = await t.sendCardFromAssistant(CARD);

    await t.aiService.handleIncomingMessage(t.io, t.room, await t.sendQuickReplyFromAlice({ cardId: card.id, choice: 'yes' }), 'pt');

    expect(await t.assistantTexts()).toContain('Ops, não consegui fazer isso agora. Tenta de novo?');
    expect(await t.messageService.isCardResolved(card.id)).toBe(false);
    expect(t.emitted.filter((entry) => entry.event === 'message:card-resolved')).toHaveLength(0);

    await t.aiService.handleIncomingMessage(t.io, t.room, await t.sendQuickReplyFromAlice({ cardId: card.id, choice: 'yes' }), 'pt');
    expect(t.handler).toHaveBeenCalledTimes(2);
    expect(await t.assistantTexts()).toContain('feito');
    expect(t.emitted.filter((entry) => entry.event === 'message:card-resolved')).toHaveLength(1);
  });
});
