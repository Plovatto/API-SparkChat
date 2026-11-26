import type { AssistantReply } from './assistant.agent.js';
import type { ConfirmDispatcher } from './assistant.confirm.js';
import type { QuickReplyContext, QuickReplyRegistry } from './assistant.quick-reply.js';
import type { NotesService } from './notes.service.js';
import { ASSISTANT_TEXTS, formatWhen } from './reminder.texts.js';
import { REMINDER_MAX_LEAD_MS, type RemindersService } from './reminders.service.js';
import { anchorFromLocal, localToUtc } from './zoned-time.js';

const SNOOZE_MINUTES = { snooze10: 10, snooze60: 60 } as const;

export function registerNoteConfirms(dispatcher: ConfirmDispatcher, notes: NotesService): void {
  dispatcher.register('delete-note', {
    declined: ASSISTANT_TEXTS.noteDeclined,
    confirm: async ({ userId, locale }, action) => {
      const removed = await notes.remove(userId, action.noteId);
      return { text: removed ? ASSISTANT_TEXTS.noteDeleted[locale] : ASSISTANT_TEXTS.noteMissing[locale], card: null };
    },
  });
}

export function registerReminderConfirms(dispatcher: ConfirmDispatcher, reminders: RemindersService, now: () => number = Date.now): void {
  dispatcher
    .register('reminder', {
      declined: ASSISTANT_TEXTS.reminderDeclined,
      confirm: async ({ userId, locale }, action) => {
        const fireAt = localToUtc(action.fireAtLocal, action.timeZone);
        const current = now();
        if (fireAt <= current || fireAt > current + REMINDER_MAX_LEAD_MS) {
          return { text: ASSISTANT_TEXTS.reminderPassed[locale], card: null };
        }
        const result = await reminders.create({
          userId,
          text: action.text,
          fireAt,
          timeZone: action.timeZone,
          locale,
          recurrence: action.recurrence,
          anchor: action.recurrence ? anchorFromLocal(action.fireAtLocal) : null,
        });
        if (result.ok) {
          return { text: ASSISTANT_TEXTS.reminderCreated(formatWhen(fireAt, action.timeZone, locale), locale), card: null };
        }
        return { text: result.error === 'limit' ? ASSISTANT_TEXTS.remindersFull[locale] : ASSISTANT_TEXTS.reminderUnavailable[locale], card: null };
      },
    })
    .register('cancel-reminder', {
      declined: ASSISTANT_TEXTS.cancelDeclined,
      confirm: async ({ userId, locale }, action) => {
        const cancelled = await reminders.cancel(userId, action.reminderId);
        return { text: cancelled ? ASSISTANT_TEXTS.cancelled[locale] : ASSISTANT_TEXTS.reminderMissing[locale], card: null };
      },
    });
}

function handleFired(reminders: RemindersService, timeZoneOf: (userId: string) => Promise<string>) {
  return async ({ userId, card, choice, locale }: QuickReplyContext): Promise<AssistantReply | null> => {
    if (card.kind !== 'reminder-fired') {
      return null;
    }
    if (choice === 'done') {
      const result = await reminders.complete(userId, card.reminderId);
      if (result.kind === 'missing') {
        return { text: ASSISTANT_TEXTS.reminderMissing[locale], card: null };
      }
      if (result.kind === 'recurring') {
        return { text: ASSISTANT_TEXTS.doneRecurring(formatWhen(result.next, await timeZoneOf(userId), locale), locale), card: null };
      }
      return { text: ASSISTANT_TEXTS.done[locale], card: null };
    }
    if (choice === 'snooze10' || choice === 'snooze60') {
      const next = await reminders.snooze(userId, card.reminderId, SNOOZE_MINUTES[choice]);
      if (next.kind === 'missing') {
        return { text: ASSISTANT_TEXTS.reminderMissing[locale], card: null };
      }
      if (next.kind === 'done') {
        return { text: ASSISTANT_TEXTS.alreadyDone[locale], card: null };
      }
      return { text: ASSISTANT_TEXTS.snoozed(formatWhen(next.at, await timeZoneOf(userId), locale), locale), card: null };
    }
    return null;
  };
}

export function registerReminderFiredReplies(
  registry: QuickReplyRegistry,
  reminders: RemindersService,
  timeZoneOf: (userId: string) => Promise<string>,
): void {
  registry.registerQuickReplyHandler('reminder-fired', handleFired(reminders, timeZoneOf));
}
