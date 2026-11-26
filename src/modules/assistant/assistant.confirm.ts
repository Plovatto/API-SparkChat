import type { Locale } from '../../lib/locale.js';
import type { AssistantReply } from './assistant.agent.js';
import type { AssistantButton, AssistantCard, ConfirmAction } from './assistant.card.js';
import type { QuickReplyContext, QuickReplyRegistry } from './assistant.quick-reply.js';

export const CONFIRM_BUTTONS: Record<Locale, AssistantButton[]> = {
  pt: [
    { choice: 'yes', label: 'Sim' },
    { choice: 'no', label: 'Não' },
  ],
  en: [
    { choice: 'yes', label: 'Yes' },
    { choice: 'no', label: 'No' },
  ],
};

export function confirmCard(action: ConfirmAction, locale: Locale): AssistantCard {
  return { v: 1, kind: 'confirm', action, buttons: CONFIRM_BUTTONS[locale] };
}

export type ConfirmActionOf<T extends ConfirmAction['type']> = Extract<ConfirmAction, { type: T }>;

export interface ConfirmHandler<T extends ConfirmAction['type']> {
  confirm(context: QuickReplyContext, action: ConfirmActionOf<T>): Promise<AssistantReply | null>;
  declined: Record<Locale, string>;
}

interface AnyConfirmHandler {
  confirm(context: QuickReplyContext, action: ConfirmAction): Promise<AssistantReply | null>;
  declined: Record<Locale, string>;
}

export class ConfirmDispatcher {
  private readonly handlers = new Map<ConfirmAction['type'], AnyConfirmHandler>();

  register<T extends ConfirmAction['type']>(type: T, handler: ConfirmHandler<T>): this {
    this.handlers.set(type, handler);
    return this;
  }

  attachTo(registry: QuickReplyRegistry): this {
    registry.registerQuickReplyHandler('confirm', (context) => this.dispatch(context));
    return this;
  }

  private dispatch(context: QuickReplyContext): Promise<AssistantReply | null> {
    const { card, choice, locale } = context;
    if (card.kind !== 'confirm') {
      return Promise.resolve(null);
    }
    const handler = this.handlers.get(card.action.type);
    if (!handler) {
      return Promise.resolve(null);
    }
    if (choice === 'no') {
      return Promise.resolve({ text: handler.declined[locale], card: null });
    }
    if (choice === 'yes') {
      return handler.confirm(context, card.action);
    }
    return Promise.resolve(null);
  }
}
