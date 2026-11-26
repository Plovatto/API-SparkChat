import type { Locale } from '../../lib/locale.js';
import type { AiConversationMessage, AiRouter, AiTurn } from '../ai/ai.provider.js';
import type { AssistantCard } from './assistant.card.js';
import { buildAssistantInstruction } from './assistant.prompt.js';
import type { AssistantContext, AssistantToolbox } from './assistant.toolbox.js';

export const ASSISTANT_MAX_TOOL_ROUNDS = 3;
export const ASSISTANT_MAX_TOOL_CALLS = 5;

const DONE_TEXT: Record<Locale, string> = {
  pt: 'Pronto! ✨',
  en: 'Done! ✨',
};

const GAVE_UP_TEXT: Record<Locale, string> = {
  pt: 'Não consegui concluir agora, tenta de novo?',
  en: "I couldn't finish that right now, try again?",
};

function withFallbackText(text: string, card: AssistantCard | null, locale: Locale): AssistantReply {
  if (text) {
    return { text, card };
  }
  return { text: card ? DONE_TEXT[locale] : GAVE_UP_TEXT[locale], card };
}

export interface AssistantReply {
  text: string;
  card: AssistantCard | null;
}

export interface AssistantTurnInput {
  history: AiConversationMessage[];
  locale: Locale;
  context: AssistantContext;
  toolbox: AssistantToolbox;
  router: AiRouter;
  catalogSummary?: string;
  extraInstruction?: string;
}

function formatLocalNow(now: number, timeZone: string, locale: Locale): { nowLocal: string; weekday: string } {
  const date = new Date(now);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  return {
    nowLocal: `${pick('year')}-${pick('month')}-${pick('day')}T${pick('hour')}:${pick('minute')}`,
    weekday: new Intl.DateTimeFormat(locale === 'pt' ? 'pt-BR' : 'en-US', { timeZone, weekday: 'long' }).format(date),
  };
}

export async function runAssistantTurn(input: AssistantTurnInput): Promise<AssistantReply> {
  const { context, toolbox, router } = input;
  const { nowLocal, weekday } = formatLocalNow(context.now, context.timeZone, input.locale);
  const options = {
    locale: input.locale,
    systemInstruction: [buildAssistantInstruction({
      locale: input.locale,
      nowLocal,
      weekday,
      timeZone: context.timeZone,
      catalogSummary: input.catalogSummary ?? '',
      toolNames: toolbox.declarations().map((declaration) => declaration.name),
    }), input.extraInstruction].filter(Boolean).join(' '),
    tools: toolbox.declarations(),
  };

  const messages = [...input.history];
  let card: AssistantCard | null = null;
  let turn: AiTurn = { text: '', calls: [] };
  let executedCalls = 0;

  for (let round = 0; round < ASSISTANT_MAX_TOOL_ROUNDS; round += 1) {
    turn = await router.generate(messages, options);
    if (turn.calls.length === 0) {
      return withFallbackText(turn.text, card, input.locale);
    }

    const responses: NonNullable<AiConversationMessage['functionResponse']> = [];
    for (const call of turn.calls) {
      if (executedCalls >= ASSISTANT_MAX_TOOL_CALLS) {
        responses.push({ id: call.id, name: call.name, response: { error: 'too_many_calls' } });
        continue;
      }
      executedCalls += 1;
      const result = await toolbox.run(call.name, call.args, context);
      if (result.card) {
        card = result.card;
      }
      responses.push({ id: call.id, name: call.name, response: result.response });
    }
    messages.push({ role: 'model', ...(turn.text ? { text: turn.text } : {}), functionCall: turn.calls });
    messages.push({ role: 'user', functionResponse: responses });
  }

  return withFallbackText(turn.text, card, input.locale);
}
