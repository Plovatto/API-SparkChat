import type { ConfirmDispatcher } from './assistant.confirm.js';
import type { QuickReplyRegistry } from './assistant.quick-reply.js';
import type { ScheduledMessagesService } from './scheduled.service.js';
import { SCHEDULED_TEXTS } from './scheduled.texts.js';

export function registerScheduledConfirms(dispatcher: ConfirmDispatcher, scheduled: ScheduledMessagesService): void {
  dispatcher
    .register('scheduled-message', {
      declined: SCHEDULED_TEXTS.declined,
      confirm: () => Promise.resolve(null),
    })
    .register('cancel-scheduled', {
      declined: SCHEDULED_TEXTS.cancelDeclined,
      confirm: async ({ userId, locale }, action) => {
        const cancelled = await scheduled.cancel(userId, action.scheduledId);
        return { text: cancelled ? SCHEDULED_TEXTS.cancelled[locale] : SCHEDULED_TEXTS.missing[locale], card: null };
      },
    });
}

export function registerScheduledFailedReplies(registry: QuickReplyRegistry): void {
  registry.registerQuickReplyHandler('scheduled-failed', ({ card, choice, locale }) =>
    Promise.resolve(card.kind === 'scheduled-failed' && choice === 'send-now' ? { text: SCHEDULED_TEXTS.sentNow[locale], card: null } : null),
  );
}
