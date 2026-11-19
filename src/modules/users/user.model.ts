import '../../docs/zod-extend.js';
import { z } from 'zod';

export const ASSISTANT_USER_ID = 'spark-ai';

export const NICKNAME_MIN_LENGTH = 2;
export const NICKNAME_MAX_LENGTH = 20;
export const NICKNAME_MIN_LETTERS = 2;
export const STATUS_TEXT_MAX_LENGTH = 30;
export const THEME_NAME_MAX_LENGTH = 50;
export const CHAT_SETTINGS_KEY_MAX_LENGTH = 100;
export const CHAT_SETTINGS_VALUE_MAX_LENGTH = 100;
export const ROOM_WALLPAPERS_MAX_ENTRIES = 200;
export const ROOM_APPEARANCE_MAX_ENTRIES = 100;

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

export type AuthVersion = 1 | 2;

const userStatusSchema = z.enum(['online', 'offline']).openapi('UserStatus');

export type UserStatus = z.infer<typeof userStatusSchema>;

export const userThemeSchema = z
  .object({
    baseTheme: z.string().max(THEME_NAME_MAX_LENGTH).openapi({ example: 'dark' }),
    colorTheme: z.string().max(THEME_NAME_MAX_LENGTH).openapi({ example: 'standard' }),
  })
  .openapi('UserTheme');

export type UserTheme = z.infer<typeof userThemeSchema>;

const settingsKeySchema = z.string().max(CHAT_SETTINGS_KEY_MAX_LENGTH);
const settingsValueSchema = z.string().max(CHAT_SETTINGS_VALUE_MAX_LENGTH);

function cappedRecord<T extends z.ZodType>(valueSchema: T, maxEntries: number) {
  return z.record(settingsKeySchema, valueSchema).refine((record) => Object.keys(record).length <= maxEntries, {
    message: `No máximo ${maxEntries} entradas.`,
  });
}

const chatAppearanceSchema = z
  .object({
    overlayOpacity: z.number(),
    overlayBlur: z.number(),
    ownBubbleColor: settingsValueSchema.nullable(),
    ownBubbleOpacity: z.number(),
    ownTextIntensity: z.number().nullable(),
    otherBubbleColor: settingsValueSchema.nullable(),
    otherBubbleOpacity: z.number(),
    otherTextIntensity: z.number().nullable(),
    bubbleBlur: z.number(),
  })
  .openapi('ChatAppearance');

export const userChatSettingsSchema = z
  .object({
    roomWallpapers: cappedRecord(settingsValueSchema, ROOM_WALLPAPERS_MAX_ENTRIES).default({}),
    globalWallpaper: settingsValueSchema.nullable().default(null),
    roomAppearance: cappedRecord(chatAppearanceSchema, ROOM_APPEARANCE_MAX_ENTRIES).default({}),
    globalAppearance: chatAppearanceSchema.nullable().default(null),
  })
  .openapi('UserChatSettings');

export type UserChatSettings = z.infer<typeof userChatSettingsSchema>;

export const publicUserSchema = z
  .object({
    id: z.string().openapi({ example: '3e3f4a1e-3b7a-4f7b-8f2a-2b7a7b9b2b2a' }),
    nickname: z.string().openapi({ example: 'Ada' }),
    avatar: z.number().int().openapi({ example: 0 }),
    status: userStatusSchema,
    statusText: z.string().nullable().openapi({ example: 'no trampo' }),
    theme: userThemeSchema,
    chatSettings: userChatSettingsSchema.nullable(),
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
