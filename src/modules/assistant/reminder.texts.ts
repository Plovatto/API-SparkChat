import type { Locale } from '../../lib/locale.js';
import type { AssistantButton, Recurrence } from './assistant.card.js';

export const REMINDER_FIRED_BUTTONS: Record<Locale, AssistantButton[]> = {
  pt: [
    { choice: 'done', label: 'Concluído' },
    { choice: 'snooze10', label: 'Adiar 10 min' },
    { choice: 'snooze60', label: 'Adiar 1 h' },
  ],
  en: [
    { choice: 'done', label: 'Done' },
    { choice: 'snooze10', label: 'Snooze 10 min' },
    { choice: 'snooze60', label: 'Snooze 1 h' },
  ],
};

const RECURRENCE_LABEL: Record<Locale, Record<Recurrence['freq'], string>> = {
  pt: { daily: 'todo dia', weekly: 'toda semana', monthly: 'todo mês' },
  en: { daily: 'every day', weekly: 'every week', monthly: 'every month' },
};

function partsOf(ms: number, timeZone: string, tag: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat(tag, { timeZone, ...options }).formatToParts(new Date(ms)).map((item) => [item.type, item.value]));
}

export function formatWhen(ms: number, timeZone: string, locale: Locale): string {
  if (locale === 'en') {
    const parts = partsOf(ms, timeZone, 'en-US', { weekday: 'short', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true });
    return `${parts.weekday}, ${parts.month}/${parts.day} at ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
  }
  const parts = partsOf(ms, timeZone, 'pt-BR', { weekday: 'short', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${(parts.weekday ?? '').replace(/\.$/, '')}, ${parts.day}/${parts.month} às ${parts.hour}:${parts.minute}`;
}

export function formatClock(ms: number, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'pt-BR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: locale === 'en' ? 'h12' : 'h23',
  }).format(new Date(ms));
}

export function confirmSummary(text: string, when: string, recurrence: Recurrence | null, locale: Locale): string {
  const repeat = recurrence ? ` (${RECURRENCE_LABEL[locale][recurrence.freq]})` : '';
  return locale === 'en' ? `Remind you '${text}' on ${when}${repeat}?` : `Lembrar '${text}' em ${when}${repeat}?`;
}

export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

export const ASSISTANT_TEXTS = {
  reminderDeclined: { pt: 'Ok, não vou lembrar.', en: "Okay, I won't remind you." } satisfies Record<Locale, string>,
  reminderCreated: (when: string, locale: Locale): string => (locale === 'en' ? `Done! I'll remind you on ${when}.` : `Combinado! Te lembro em ${when}.`),
  reminderPassed: { pt: 'Esse horário já passou. Me diz um novo horário?', en: 'That time has already passed. Tell me a new time?' } satisfies Record<Locale, string>,
  remindersFull: { pt: 'Você já tem 50 lembretes ativos. Cancele algum antes de criar outro.', en: 'You already have 50 active reminders. Cancel one before creating another.' } satisfies Record<Locale, string>,
  reminderUnavailable: { pt: 'Não consegui guardar o lembrete agora. Tenta de novo?', en: "I couldn't save the reminder right now. Try again?" } satisfies Record<Locale, string>,
  cancelDeclined: { pt: 'Ok, mantive o lembrete.', en: 'Okay, I kept the reminder.' } satisfies Record<Locale, string>,
  cancelled: { pt: 'Lembrete cancelado.', en: 'Reminder cancelled.' } satisfies Record<Locale, string>,
  reminderMissing: { pt: 'Não achei esse lembrete.', en: "I couldn't find that reminder." } satisfies Record<Locale, string>,
  done: { pt: 'Concluído! ✅', en: 'Done! ✅' } satisfies Record<Locale, string>,
  snoozed: (clock: string, locale: Locale): string => (locale === 'en' ? `Snoozed! I'll remind you again at ${clock}.` : `Adiado! Te lembro de novo às ${clock}.`),
  fired: (text: string): string => `⏰ ${text}`,
  firedFallback: { pt: 'Lembrete', en: 'Reminder' } satisfies Record<Locale, string>,
  remindersTitle: { pt: 'Seus lembretes', en: 'Your reminders' } satisfies Record<Locale, string>,
  notesTitle: { pt: 'Suas anotações', en: 'Your notes' } satisfies Record<Locale, string>,
  noteDeclined: { pt: 'Ok, mantive a anotação.', en: 'Okay, I kept the note.' } satisfies Record<Locale, string>,
  noteDeleted: { pt: 'Anotação apagada.', en: 'Note deleted.' } satisfies Record<Locale, string>,
  noteMissing: { pt: 'Não achei essa anotação.', en: "I couldn't find that note." } satisfies Record<Locale, string>,
};
