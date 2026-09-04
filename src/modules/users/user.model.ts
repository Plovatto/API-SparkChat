import '../../docs/zod-extend.js';
import { z } from 'zod';

export const ASSISTANT_USER_ID = 'spark-ai';

export const NICKNAME_MIN_LENGTH = 2;
export const NICKNAME_MAX_LENGTH = 20;
export const NICKNAME_MIN_LETTERS = 2;
export const PASSWORD_MIN_LENGTH = 12;
export const STATUS_TEXT_MAX_LENGTH = 30;

const NICKNAME_CHARSET_PATTERN = /^[\p{L}\p{N}]+$/u;
const NICKNAME_LETTER_PATTERN = /\p{L}/gu;

export function isValidNicknameFormat(nickname: string): boolean {
  const trimmed = nickname.trim();

  if (trimmed.length < NICKNAME_MIN_LENGTH || trimmed.length > NICKNAME_MAX_LENGTH) {
    return false;
  }

  if (!NICKNAME_CHARSET_PATTERN.test(trimmed)) {
    return false;
  }

  const letterCount = trimmed.match(NICKNAME_LETTER_PATTERN)?.length ?? 0;
  return letterCount >= NICKNAME_MIN_LETTERS;
}

export type AuthMethod = 'password' | 'keyfile';

const userStatusSchema = z.enum(['online', 'offline']).openapi('UserStatus');

export type UserStatus = z.infer<typeof userStatusSchema>;

export const userThemeSchema = z
  .object({
    baseTheme: z.string().openapi({ example: 'dark' }),
    colorTheme: z.string().openapi({ example: 'standard' }),
  })
  .openapi('UserTheme');

export type UserTheme = z.infer<typeof userThemeSchema>;

export const publicUserSchema = z
  .object({
    id: z.string().openapi({ example: '3e3f4a1e-3b7a-4f7b-8f2a-2b7a7b9b2b2a' }),
    nickname: z.string().openapi({ example: 'Ada' }),
    avatar: z.number().int().openapi({ example: 0 }),
    status: userStatusSchema,
    statusText: z.string().nullable().openapi({ example: 'no trampo' }),
    theme: userThemeSchema,
  })
  .openapi('PublicUser');

export type PublicUser = z.infer<typeof publicUserSchema>;

export const nicknameAvailabilityStatusSchema = z.enum(['available', 'taken', 'invalid']).openapi('NicknameAvailabilityStatus');

export type NicknameAvailabilityStatus = z.infer<typeof nicknameAvailabilityStatusSchema>;

export interface SessionSummary {
  id: string;
  authMethod: AuthMethod;
  device: string;
  createdAt: string;
  lastUsedAt: string;
  isCurrent: boolean;
}
