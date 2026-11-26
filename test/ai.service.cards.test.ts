import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { openField } from '@/modules/ai/ai.crypto.js';
import { AiRouter } from '@/modules/ai/ai.provider.js';
import type { AssistantCard } from '@/modules/assistant/assistant.card.js';
import { AssistantToolbox, defineTool } from '@/modules/assistant/assistant.toolbox.js';
import { createFakeServer, setupAssistantRoom } from './support/ai-fixture.js';

const CARD: AssistantCard = { v: 1, kind: 'choices', buttons: [{ choice: 'yes', label: 'Sim' }] };

afterEach(() => {
  vi.useRealTimers();
});

describe('AiService assistant cards', () => {
  it('seals the tool card into the reply message', async () => {
    const toolbox = new AssistantToolbox();
    toolbox.register(
      defineTool({
        declaration: { name: 'show', description: 'show' },
        schema: z.object({}),
        run: () => Promise.resolve({ response: {}, card: CARD }),
      }),
    );
    let round = 0;
    const router = new AiRouter([
      {
        generate: () => {
          round += 1;
          return Promise.resolve(round === 1 ? { text: '', calls: [{ id: '1', name: 'show', args: {} }] } : { text: 'olha', calls: [] });
        },
      },
    ]);
    const context = await setupAssistantRoom({ router, toolbox });
    const { aiService, messageService, room, alice, assistant, identity, roomKey, sendFromAlice } = context;

    await aiService.handleIncomingMessage(createFakeServer(), room, await sendFromAlice('mostra'), 'pt');

    await vi.waitFor(async () => {
      const { messages } = await messageService.getRoomMessagesPage(room.id, { limit: 10 });
      expect(messages.some((message) => message.senderId === assistant.id)).toBe(true);
    }, { timeout: 10000 });

    const { messages } = await messageService.getRoomMessagesPage(room.id, { limit: 10 });
    const reply = messages.find((message) => message.senderId !== alice.id);
    expect(reply?.assistantCard).toBeDefined();
    const opened = await openField(reply?.assistantCard ?? '', roomKey, identity.signingPublicKeyBytes, {
      roomId: room.id,
      senderId: assistant.id,
      messageId: reply?.id ?? '',
      label: 'assistantCard',
    });
    expect(JSON.parse(opened ?? '')).toEqual(CARD);
    expect(await context.openFromAssistant(reply as NonNullable<typeof reply>)).toBe('olha');
  });
});
