import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { publicUserSchema } from './user.model.js';
import type { UserService } from './user.service.js';

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

export function createUserController(userService: UserService) {
  return {
    async validateLoginCode(req: Request, res: Response): Promise<void> {
      const parsed = validateCodeBodySchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({ message: 'Código de login é obrigatório!' });
        return;
      }

      try {
        const user = await userService.validateLoginCode(parsed.data.loginCode);

        if (!user) {
          res.status(404).json({ message: 'Código de login inválido ou não encontrado!' });
          return;
        }

        res.status(200).json({
          message: 'Código validado com sucesso!',
          user: userService.toPublicUser(user),
        });
      } catch (error) {
        logger.error({ err: error }, 'Failed to validate login code');
        res.status(500).json({ message: 'Erro ao validar código. Tente novamente!' });
      }
    },
  };
}
