import type { Request, Response } from 'express';
import { logger } from '../config/logger.js';
import { validateCodeBodySchema } from '../models/user.model.js';
import type { UserService } from '../services/user.service.js';

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
