import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiRouter } from '@/modules/ai/ai.provider.js';
import { AiUsageLimiter, AiUsageRepository } from '@/modules/ai/ai.usage-limiter.js';
import { HELP_TOPICS } from '@/modules/assistant/assistant.card.js';
import { HELP_CATALOG, HELP_SHORTCUT_REPLY } from '@/modules/assistant/assistant.help-catalog.js';
import { buildAssistantInstruction } from '@/modules/assistant/assistant.prompt.js';
import { AssistantToolbox, type AssistantContext } from '@/modules/assistant/assistant.toolbox.js';
import { appHelpTool } from '@/modules/assistant/tools/app-help.tool.js';
import { capabilitiesTool } from '@/modules/assistant/tools/capabilities.tool.js';
import { openField } from '@/modules/ai/ai.crypto.js';
import { createFakeServer, setupAssistantRoom } from './support/ai-fixture.js';
import { createTestDb } from './support/create-test-db.js';

const CONTEXT: AssistantContext = { userId: 'u', roomId: 'r', locale: 'pt', io: {} as never, timeZone: 'America/Sao_Paulo', now: 0 };

function toolbox(): AssistantToolbox {
  return new AssistantToolbox().register(capabilitiesTool).register(appHelpTool);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('capabilities and help tools', () => {
  it('show_capabilities returns the capabilities card', async () => {
    const result = await toolbox().run('show_capabilities', {}, CONTEXT);
    expect(result.card).toEqual({ v: 1, kind: 'capabilities' });
  });

  it('app_help returns the help card with the mapped target and the localized text', async () => {
    const pt = await toolbox().run('app_help', { topic: 'wallpaper' }, CONTEXT);
    expect(pt.card).toEqual({ v: 1, kind: 'help', topic: 'wallpaper', target: 'appearance' });
    expect(pt.response.explanation).toBe(HELP_CATALOG.wallpaper.text.pt);
    const en = await toolbox().run('app_help', { topic: 'install-app' }, { ...CONTEXT, locale: 'en' });
    expect(en.card).toEqual({ v: 1, kind: 'help', topic: 'install-app', target: 'install' });
    expect(en.response.explanation).toBe(HELP_CATALOG['install-app'].text.en);
  });

  it('app_help rejects an unknown topic with invalid_args', async () => {
    const result = await toolbox().run('app_help', { topic: 'teleport' }, CONTEXT);
    expect(result.response).toEqual({ error: 'invalid_args' });
    expect(result.card).toBeUndefined();
  });

  it('declares app_help with every topic', () => {
    const declaration = toolbox().declarations().find((item) => item.name === 'app_help');
    const topics = (declaration?.parameters as { properties: { topic: { enum: string[] } } }).properties.topic.enum;
    expect(topics).toEqual([...HELP_TOPICS]);
  });

  it('has a short pt and en text for every topic', () => {
    for (const topic of HELP_TOPICS) {
      for (const locale of ['pt', 'en'] as const) {
        const text = HELP_CATALOG[topic].text[locale];
        const sentences = text.split(/(?<=[.!?])\s+/).length;
        expect(sentences).toBeGreaterThanOrEqual(2);
        expect(sentences).toBeLessThanOrEqual(4);
      }
    }
  });

  it('maps the topics to their targets', () => {
    expect(HELP_CATALOG.themes.target).toBe('appearance');
    expect(HELP_CATALOG.bubbles.target).toBe('appearance');
    expect(HELP_CATALOG['profile-photo'].target).toBe('profile');
    expect(HELP_CATALOG.groups.target).toBe('new-group');
    expect(HELP_CATALOG['invite-link'].target).toBe('none');
    expect(HELP_CATALOG.notifications.target).toBe('notifications-settings');
    expect(HELP_CATALOG.calls.target).toBe('none');
  });

  it('mentions both tools in the pt and en prompts', () => {
    for (const locale of ['pt', 'en'] as const) {
      const prompt = buildAssistantInstruction({ locale, nowLocal: '2026-11-26T10:00', weekday: 'x', timeZone: 'UTC', catalogSummary: '', toolNames: ['show_capabilities', 'app_help'] });
      expect(prompt).toContain('show_capabilities');
      expect(prompt).toContain('app_help');
    }
  });
});

describe('help shortcut', () => {
  async function setup() {
    const generate = vi.fn(() => Promise.resolve({ text: 'ok', calls: [] }));
    const usageLimiter = new AiUsageLimiter(new AiUsageRepository(await createTestDb()), 3);
    const context = await setupAssistantRoom({ router: new AiRouter([{ generate }]), usageLimiter });
    return { ...context, generate, usageLimiter };
  }

  it.each(['/ajuda', '/help', '  /AJUDA ', '/Help'])('answers %j with the capabilities card without calling the provider or counting', async (text) => {
    const { aiService, messageService, room, alice, assistant, identity, roomKey, generate, usageLimiter, sendFromAlice } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });

    await aiService.handleIncomingMessage(createFakeServer(), room, await sendFromAlice(text), 'pt');

    const { messages } = await messageService.getRoomMessagesPage(room.id, { limit: 10 });
    const reply = messages.find((message) => message.senderId === assistant.id);
    expect(reply).toBeDefined();
    const opened = await openField(reply?.assistantCard ?? '', roomKey, identity.signingPublicKeyBytes, {
      roomId: room.id,
      senderId: assistant.id,
      messageId: reply?.id ?? '',
      label: 'assistantCard',
    });
    expect(JSON.parse(opened ?? '')).toEqual({ v: 1, kind: 'capabilities' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(generate).not.toHaveBeenCalled();
    expect(await usageLimiter.isBlocked(alice.id)).toBe(false);
    for (let index = 0; index < 3; index += 1) {
      expect(await usageLimiter.tryConsume(alice.id)).toBe(true);
    }
  });

  it('answers in English with the English line', async () => {
    const { aiService, room, assistantTexts, sendFromAlice } = await setup();
    await aiService.handleIncomingMessage(createFakeServer(), room, await sendFromAlice('/help'), 'en');
    expect(await assistantTexts()).toEqual([HELP_SHORTCUT_REPLY.en]);
  });

  it('never falls through to the provider or the limiter when the reply fails to send', async () => {
    const { aiService, messageService, room, alice, generate, usageLimiter, sendFromAlice } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const message = await sendFromAlice('/ajuda');
    vi.spyOn(messageService, 'sendMessage').mockRejectedValue(new Error('db down'));

    await expect(aiService.handleIncomingMessage(createFakeServer(), room, message, 'pt')).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(3000);

    expect(generate).not.toHaveBeenCalled();
    for (let index = 0; index < 3; index += 1) {
      expect(await usageLimiter.tryConsume(alice.id)).toBe(true);
    }
  });

  it('sends other text to the provider', async () => {
    const { aiService, room, generate, sendFromAlice } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });

    await aiService.handleIncomingMessage(createFakeServer(), room, await sendFromAlice('/ajuda por favor'), 'pt');
    await vi.advanceTimersByTimeAsync(3000);

    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  });
});
