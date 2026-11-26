import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiRouter } from '@/modules/ai/ai.provider.js';
import type { AssistantCard } from '@/modules/assistant/assistant.card.js';
import { QuickReplyRegistry } from '@/modules/assistant/assistant.quick-reply.js';
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

  it('asks the model for a different suggestion on another, without using the daily limit', async () => {
    const generate = vi.fn().mockResolvedValue({ text: 'que tal este?', calls: [] });
    const tryConsume = vi.fn().mockResolvedValue(false);
    const t = await setup({ router: new AiRouter([{ generate }]), usageLimiter: { tryConsume } as never });
    const card = await t.sendCardFromAssistant({ v: 1, kind: 'look-suggestion', look: {}, buttons: [{ choice: 'another', label: 'Outra' }] });

    await t.aiService.handleIncomingMessage(t.io, t.room, await t.sendQuickReplyFromAlice({ cardId: card.id, choice: 'another' }), 'pt');

    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1), { timeout: 10000 });
    const options = generate.mock.calls[0]?.[1] as { systemInstruction: string };
    expect(options.systemInstruction).toContain('outra sugestão');
    expect(tryConsume).not.toHaveBeenCalled();
    expect(t.handler).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect(await t.assistantTexts()).toContain('que tal este?'), { timeout: 10000 });
  });
});
