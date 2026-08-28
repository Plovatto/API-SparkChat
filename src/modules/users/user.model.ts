import '../../docs/zod-extend.js';
import { z } from 'zod';

export const userStatusSchema = z.enum(['online', 'offline']).openapi('UserStatus');

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
    loginCode: z.string().openapi({ example: '123456' }),
    chatCode: z.string().openapi({ example: 'AB12CD' }),
    status: userStatusSchema,
    theme: userThemeSchema,
  })
  .openapi('PublicUser');

export type PublicUser = z.infer<typeof publicUserSchema>;
