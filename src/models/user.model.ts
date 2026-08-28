import '../docs/zod-extend.js';
import { z } from 'zod';

export type UserStatus = 'online' | 'offline';

export const userThemeSchema = z
  .object({
    baseTheme: z.string().openapi({ example: 'dark' }),
    colorTheme: z.string().openapi({ example: 'standard' }),
  })
  .openapi('UserTheme');

export type UserTheme = z.infer<typeof userThemeSchema>;

export interface UserRecord {
  id: string;
  nickname: string;
  avatar: number;
  chatCode: string;
  loginCode: string;
  socketId: string;
  status: UserStatus;
  createdAt: string;
  lastSeen: string;
  theme?: UserTheme;
}

export const publicUserSchema = z
  .object({
    id: z.string().openapi({ example: '3e3f4a1e-3b7a-4f7b-8f2a-2b7a7b9b2b2a' }),
    nickname: z.string().openapi({ example: 'Ada' }),
    avatar: z.number().int().openapi({ example: 0 }),
    loginCode: z.string().openapi({ example: '123456' }),
    chatCode: z.string().openapi({ example: 'AB12CD' }),
    status: z.enum(['online', 'offline']).openapi({ example: 'online' }),
    theme: userThemeSchema,
  })
  .openapi('PublicUser');

export type PublicUser = z.infer<typeof publicUserSchema>;

export const joinPayloadSchema = z.object({
  nickname: z.string().trim().min(1).optional(),
  avatar: z.number().int().min(0).optional(),
  loginCode: z.string().trim().min(1).optional().nullable(),
});

export type JoinPayload = z.infer<typeof joinPayloadSchema>;

export const validateCodeBodySchema = z
  .object({
    loginCode: z.string().trim().min(1).openapi({ example: '123456', description: 'Código de login de 6 dígitos' }),
  })
  .openapi('ValidateCodeBody');

export type ValidateCodeBody = z.infer<typeof validateCodeBodySchema>;

export const validateCodeResponseSchema = z
  .object({
    message: z.string().openapi({ example: 'Código validado com sucesso!' }),
    user: publicUserSchema,
  })
  .openapi('ValidateCodeResponse');

export const errorResponseSchema = z
  .object({
    message: z.string().openapi({ example: 'Código de login inválido ou não encontrado!' }),
  })
  .openapi('ErrorResponse');
