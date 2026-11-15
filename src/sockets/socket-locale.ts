import { z } from 'zod';
import type { AppSocket } from './events.js';

export const SUPPORTED_LOCALES = ['pt', 'en'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'pt';

export const handshakeAuthSchema = z.object({
  locale: z.enum(SUPPORTED_LOCALES).optional(),
});

export function resolveHandshakeLocale(auth: unknown): Locale {
  const locale = typeof auth === 'object' && auth !== null ? (auth as { locale?: unknown }).locale : undefined;
  const parsed = handshakeAuthSchema.shape.locale.safeParse(locale);
  return parsed.success && parsed.data ? parsed.data : DEFAULT_LOCALE;
}

export function socketLocale(socket: AppSocket): Locale {
  return socket.data.locale ?? DEFAULT_LOCALE;
}
