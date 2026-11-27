import type { Locale } from '../../lib/locale.js';
import type { AssistantButton } from './assistant.card.js';

export const SCHEDULED_MAX_PENDING = 20;
export const SCHEDULED_MIN_LEAD_MS = 60_000;
export const SCHEDULED_MAX_LEAD_MS = 366 * 86_400_000;
export const SCHEDULED_SOCKET_MIN_LEAD_MS = 30_000;
export const SCHEDULED_TEXT_MAX_LENGTH = 4000;
export const SCHEDULED_DUE_BATCH = 50;
export const SCHEDULED_STUCK_AFTER_MS = 120_000;

export const SCHEDULED_FAILED_BUTTONS: Record<Locale, AssistantButton[]> = {
  pt: [{ choice: 'send-now', label: 'Enviar agora' }],
  en: [{ choice: 'send-now', label: 'Send now' }],
};

export const SCHEDULED_TEXTS = {
  confirmSummary: (text: string, recipient: string, when: string, locale: Locale): string =>
    locale === 'en' ? `Schedule '${text}' to ${recipient} on ${when}?` : `Agendar '${text}' pra ${recipient} em ${when}?`,
  declined: { pt: 'Ok, não vou agendar.', en: "Okay, I won't schedule it." } satisfies Record<Locale, string>,
  scheduled: (recipient: string, when: string, locale: Locale): string =>
    locale === 'en' ? `Scheduled ✅ I'll send it to ${recipient} on ${when}.` : `Agendado ✅ Vou enviar pra ${recipient} em ${when}.`,
  title: { pt: 'Mensagens agendadas', en: 'Scheduled messages' } satisfies Record<Locale, string>,
  listDetail: (recipient: string, when: string, locale: Locale): string => (locale === 'en' ? `To ${recipient} · ${when}` : `Para ${recipient} · ${when}`),
  cancelPreview: (recipient: string, text: string): string => `${recipient}: ${text}`,
  cancelDeclined: { pt: 'Ok, mantive o agendamento.', en: 'Okay, I kept it scheduled.' } satisfies Record<Locale, string>,
  cancelled: { pt: 'Agendamento cancelado.', en: 'Scheduled message cancelled.' } satisfies Record<Locale, string>,
  missing: { pt: 'Não achei essa mensagem agendada.', en: "I couldn't find that scheduled message." } satisfies Record<Locale, string>,
  failed: (recipient: string, locale: Locale): string =>
    locale === 'en'
      ? `I couldn't send your scheduled message to ${recipient}. Want to send it now?`
      : `Não consegui enviar sua mensagem agendada pra ${recipient}. Quer enviar agora?`,
  failedUnknown: {
    pt: 'Não consegui enviar uma mensagem agendada. Abra a conversa e envie de novo.',
    en: "I couldn't send a scheduled message. Open the chat and send it again.",
  } satisfies Record<Locale, string>,
  sentNow: { pt: 'Enviado! 📨', en: 'Sent! 📨' } satisfies Record<Locale, string>,
};
