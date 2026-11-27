import type { Locale } from '../../lib/locale.js';
import { formatWhen } from './reminder.texts.js';
import { utcToLocalParts } from './zoned-time.js';

export const STATUS_MAX_LEAD_MS = 7 * 24 * 60 * 60 * 1000;

function clock(ms: number, timeZone: string, locale: Locale): string {
  if (locale === 'en') {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ms)).map((item) => [item.type, item.value]),
    );
    return `${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((item) => [item.type, item.value]),
  );
  return `${parts.hour}:${parts.minute}`;
}

export function formatUntil(ms: number, now: number, timeZone: string, locale: Locale): string {
  const target = utcToLocalParts(ms, timeZone);
  const today = utcToLocalParts(now, timeZone);
  const sameDay = target.year === today.year && target.month === today.month && target.day === today.day;
  return sameDay ? clock(ms, timeZone, locale) : formatWhen(ms, timeZone, locale);
}

export const STATUS_TEXTS = {
  confirmSummary: (text: string, until: string, locale: Locale): string =>
    locale === 'en' ? `Set your status to '${text}' until ${until}?` : `Colocar seu status como '${text}' até ${until}?`,
  applied: (text: string, until: string, locale: Locale): string =>
    locale === 'en' ? `Done! Your status is now '${text}' until ${until}.` : `Prontinho! Seu status agora é '${text}' até ${until}.`,
  declined: { pt: 'Ok, deixei seu status como estava.', en: 'Okay, I left your status as it was.' } satisfies Record<Locale, string>,
  passed: { pt: 'Esse horário já passou. Me diz até quando?', en: 'That time has already passed. Until when?' } satisfies Record<Locale, string>,
  unavailable: { pt: 'Não consegui mudar o status agora. Tenta de novo?', en: "I couldn't change your status right now. Try again?" } satisfies Record<Locale, string>,
};
