import type { Locale } from '../../lib/locale.js';
import type { AiConversationMessage, AiRouter, AiTurn } from '../ai/ai.provider.js';
import type { AssistantCard } from './assistant.card.js';
import { buildAssistantInstruction } from './assistant.prompt.js';
import { catalogSummary } from './look.catalog.js';
import { mergeAppliedCards } from './look.merge.js';
import type { AssistantContext, AssistantToolbox } from './assistant.toolbox.js';
import { nowLocalString } from './zoned-time.js';
import { logger } from '../../config/logger.js';
import { actionIntentReason, forcedToolNames } from './assistant.claim-guard.js';

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

const NUDGE: Record<Locale, string> = {
  pt: 'Atenção: para agir ou confirmar algo você precisa chamar a ferramenta correspondente agora. Chame a ferramenta adequada ao pedido.',
  en: 'Attention: to act or ask for confirmation you must call the matching tool now. Call the tool that fits the request.',
};

function latestUserText(history: AiConversationMessage[]): string {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role === 'user' && message.text) {
      return message.text;
    }
  }
  return '';
}

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
  forceTool?: string;
}

function formatLocalNow(now: number, timeZone: string, locale: Locale): { nowLocal: string; weekday: string } {
  return {
    nowLocal: nowLocalString(now, timeZone),
    weekday: new Intl.DateTimeFormat(locale === 'pt' ? 'pt-BR' : 'en-US', { timeZone, weekday: 'long' }).format(new Date(now)),
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
      catalogSummary: input.catalogSummary ?? (toolbox.has('suggest_look') || toolbox.has('apply_look') ? catalogSummary(input.locale) : ''),
      toolNames: toolbox.declarations().map((declaration) => declaration.name),
    }), input.extraInstruction].filter(Boolean).join(' '),
    tools: toolbox.declarations(),
  };

  const toolNames = options.tools.map((tool) => tool.name);
  const userText = latestUserText(input.history);
  const forcedNames = forcedToolNames(toolNames, userText);
  const forcedOptions = {
    ...options,
    systemInstruction: `${options.systemInstruction} ${NUDGE[input.locale]}`,
    toolConfig: { mode: 'ANY' as const, allowedFunctionNames: forcedNames },
  };
  const firstForcedOptions = input.forceTool ? { ...forcedOptions, toolConfig: { mode: 'ANY' as const, allowedFunctionNames: [input.forceTool] } } : forcedOptions;

  const messages = [...input.history];
  let card: AssistantCard | null = null;
  let turn: AiTurn = { text: '', calls: [] };
  let executedCalls = 0;

  const forceFirst = input.forceTool !== undefined && toolbox.has(input.forceTool);
  let guarded = forceFirst;
  let forceNext = forceFirst;

  for (let round = 0; round < ASSISTANT_MAX_TOOL_ROUNDS; round += 1) {
    turn = await router.generate(messages, forceNext ? (round === 0 && forceFirst ? firstForcedOptions : forcedOptions) : options);
    forceNext = false;
    if (turn.calls.length === 0) {
      const reason = guarded || executedCalls > 0 || forcedNames.length === 0 ? null : actionIntentReason(userText, turn.text);
      if (!reason) {
        return withFallbackText(turn.text, card, input.locale);
      }
      logger.warn({ roomId: context.roomId, reason }, 'SparkAI respondeu sem chamar ferramenta; repetindo com chamada forçada');
      guarded = true;
      forceNext = true;
      messages.push({ role: 'model', text: turn.text });
      messages.push({ role: 'user', text: NUDGE[input.locale] });
      continue;
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
        card = mergeAppliedCards(card, result.card);
      }
      responses.push({ id: call.id, name: call.name, response: result.response });
    }
    messages.push({ role: 'model', ...(turn.text ? { text: turn.text } : {}), functionCall: turn.calls });
    messages.push({ role: 'user', functionResponse: responses });
  }

  return withFallbackText(turn.text, card, input.locale);
}
