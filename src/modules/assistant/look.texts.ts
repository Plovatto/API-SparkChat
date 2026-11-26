import type { Locale } from '../../lib/locale.js';
import type { AssistantButton } from './assistant.card.js';

export const LOOK_SUGGESTION_BUTTONS: Record<Locale, AssistantButton[]> = {
  pt: [
    { choice: 'yes', label: 'Aplicar' },
    { choice: 'no', label: 'Não' },
    { choice: 'another', label: 'Outra sugestão' },
  ],
  en: [
    { choice: 'yes', label: 'Apply' },
    { choice: 'no', label: 'No' },
    { choice: 'another', label: 'Another one' },
  ],
};

export const LOOK_APPLIED_BUTTONS: Record<Locale, AssistantButton[]> = {
  pt: [{ choice: 'undo', label: 'Desfazer' }],
  en: [{ choice: 'undo', label: 'Undo' }],
};

export const LOOK_DECLINED_BUTTONS: Record<Locale, AssistantButton[]> = {
  pt: [
    { choice: 'another', label: 'Outra sugestão' },
    { choice: 'keep', label: 'Deixa assim' },
  ],
  en: [
    { choice: 'another', label: 'Another one' },
    { choice: 'keep', label: 'Keep it' },
  ],
};

export const LOOK_TEXTS = {
  applied: (description: string, locale: Locale): string => (locale === 'en' ? `Done! I applied the ${description}.` : `Pronto! Apliquei ${description}.`),
  undone: (description: string, locale: Locale): string => (locale === 'en' ? `Undone! I put the ${description} back.` : `Desfeito! Voltei ${description}.`),
  declined: { pt: 'Sem problemas!', en: 'No problem!' } satisfies Record<Locale, string>,
  kept: { pt: 'Combinado!', en: 'Deal!' } satisfies Record<Locale, string>,
};
