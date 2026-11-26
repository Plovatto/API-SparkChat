import type { Locale } from '../../lib/locale.js';

export const ASSISTANT_NICKNAME = 'SparkAI';
export const ASSISTANT_NICKNAME_NORMALIZED = 'sparkai';
export const ASSISTANT_AVATAR = 1;
export const ASSISTANT_STATUS_TEXT = '100% pilha, 0% sono 🔋';

export const AI_WELCOME_MESSAGES: Record<Locale, string> = {
  pt: 'Oi! Eu sou o SparkAI 🤖✨ Bato papo e também te dou uma mão de verdade: troco seu tema, anoto, te lembro das coisas e muito mais. Dá uma olhada no que eu sei fazer 👇',
  en: "Hi! I'm SparkAI 🤖✨ I chat and I also lend a real hand: I change your theme, take notes, remind you of things and more. Take a look at what I can do 👇",
};

export const AI_DAILY_MESSAGE_LIMIT = 50;
export const AI_CONTEXT_MESSAGE_LIMIT = 20;
export const AI_MAX_OUTPUT_TOKENS = 1024;

export const AI_MAX_TEXT_CHARS = 2000;
export const AI_MAX_TEXT_FILE_CHARS = 4000;

export const AI_MAX_IMAGE_DIMENSION = 768;
export const AI_IMAGE_JPEG_QUALITY = 70;

export const AI_MAX_AUDIO_SECONDS = 60;
export const AI_MAX_PDF_BYTES = 4 * 1024 * 1024;
export const AI_MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const AI_MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const AI_MAX_TEXT_FILE_BYTES = 1024 * 1024;
export const AI_MAX_IMAGE_INPUT_PIXELS = 40_000_000;

export const AI_BATCH_DEBOUNCE_MS = 2500;

export const AI_PRIMARY_MODEL = 'gemini-3.5-flash-lite';
export const AI_FALLBACK_MODEL = 'gemini-3.1-flash-lite';
