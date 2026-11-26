import type { AssistantReply } from './assistant.agent.js';
import type { QuickReplyContext, QuickReplyRegistry } from './assistant.quick-reply.js';
import { describeLook, type LookService } from './look.service.js';
import { LOOK_APPLIED_BUTTONS, LOOK_DECLINED_BUTTONS, LOOK_TEXTS } from './look.texts.js';

function handleSuggestion(looks: LookService) {
  return async ({ io, userId, card, choice, locale }: QuickReplyContext): Promise<AssistantReply | null> => {
    if (card.kind !== 'look-suggestion') {
      return null;
    }
    if (choice === 'yes') {
      const { previous } = await looks.applyLook(io, userId, card.look);
      return {
        text: LOOK_TEXTS.applied(describeLook(card.look, locale), locale),
        card: { v: 1, kind: 'look-applied', look: card.look, previous, buttons: LOOK_APPLIED_BUTTONS[locale] },
      };
    }
    if (choice === 'no') {
      return { text: LOOK_TEXTS.declined[locale], card: { v: 1, kind: 'choices', buttons: LOOK_DECLINED_BUTTONS[locale] } };
    }
    return null;
  };
}

function handleApplied(looks: LookService) {
  return async ({ io, userId, card, choice, locale }: QuickReplyContext): Promise<AssistantReply | null> => {
    if (card.kind !== 'look-applied' || choice !== 'undo') {
      return null;
    }
    await looks.applyLook(io, userId, card.previous);
    return { text: LOOK_TEXTS.undone(describeLook(card.previous, locale), locale), card: null };
  };
}

function handleChoices({ card, choice, locale }: QuickReplyContext): Promise<AssistantReply | null> {
  if (card.kind === 'choices' && choice === 'keep') {
    return Promise.resolve({ text: LOOK_TEXTS.kept[locale], card: null });
  }
  return Promise.resolve(null);
}

export function registerLookQuickReplies(registry: QuickReplyRegistry, looks: LookService): void {
  registry
    .registerQuickReplyHandler('look-suggestion', handleSuggestion(looks))
    .registerQuickReplyHandler('look-applied', handleApplied(looks))
    .registerQuickReplyHandler('choices', handleChoices);
}
