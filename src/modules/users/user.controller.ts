import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { isValidNicknameFormat, nicknameAvailabilityStatusSchema, publicUserSchema } from './user.model.js';
import type { LoginRateLimiter } from './user.login-rate-limiter.js';
import type { UserService } from './user.service.js';

export const nicknameAvailabilityQuerySchema = z
  .object({
    nickname: z.string().trim().min(1).openapi({ example: 'Ada' }),
  })
  .openapi('NicknameAvailabilityQuery');

export const nicknameAvailabilityResponseSchema = z
  .object({
    status: nicknameAvailabilityStatusSchema,
  })
  .openapi('NicknameAvailabilityResponse');

export const loginBodySchema = z
  .object({
    nickname: z.string().trim().min(1).openapi({ example: 'Ada' }),
    password: z.string().min(1).openapi({ example: 'correct-horse-battery-staple' }),
  })
  .openapi('LoginBody');

export const loginResponseSchema = z
  .object({
    message: z.string().openapi({ example: 'Login realizado com sucesso!' }),
    user: publicUserSchema,
    sessionToken: z.string().openapi({ example: 'a1b2c3...' }),
  })
  .openapi('LoginResponse');

export const keyfileLoginResponseSchema = loginResponseSchema
  .extend({
    recoveryToken: z.string().openapi({ example: 'a1b2c3...', description: 'Necessário para restaurar a chave de criptografia local do usuário' }),
  })
  .openapi('KeyfileLoginResponse');

const TOO_MANY_ATTEMPTS_MESSAGE = 'Muitas tentativas de login. Tente novamente mais tarde.';
const LOGIN_FAILED_MESSAGE = 'Erro ao entrar. Tente novamente!';

export function createUserController(userService: UserService, loginRateLimiter: LoginRateLimiter) {
  const login = async (req: Request, res: Response): Promise<void> => {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Nickname e senha são obrigatórios!' });
      return;
    }

    const { nickname, password } = parsed.data;
    const ip = req.ip ?? 'unknown';

    if (loginRateLimiter.isBlocked(nickname, ip)) {
      res.status(429).json({ message: TOO_MANY_ATTEMPTS_MESSAGE });
      return;
    }

    try {
      const result = await userService.login(nickname, password, req.headers['user-agent'] ?? '');
      if (!result) {
        loginRateLimiter.registerFailure(nickname, ip);
        res.status(401).json({ message: 'Nickname ou senha inválidos.' });
        return;
      }

      loginRateLimiter.registerSuccess(nickname, ip);
      res.status(200).json({
        message: 'Login realizado com sucesso!',
        user: userService.toPublicUser(result.user),
        sessionToken: result.sessionToken,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to log in');
      res.status(500).json({ message: LOGIN_FAILED_MESSAGE });
    }
  };

  const loginWithKeyfile = async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ message: 'Arquivo de recuperação é obrigatório!' });
      return;
    }

    const ip = req.ip ?? 'unknown';

    if (loginRateLimiter.isBlockedByIp(ip)) {
      res.status(429).json({ message: TOO_MANY_ATTEMPTS_MESSAGE });
      return;
    }

    try {
      const result = await userService.loginWithKeyfile(req.file.buffer, req.headers['user-agent'] ?? '');
      if (!result) {
        loginRateLimiter.registerFailureByIp(ip);
        res.status(401).json({ message: 'Arquivo de recuperação inválido.' });
        return;
      }

      loginRateLimiter.registerSuccessByIp(ip);
      res.status(200).json({
        message: 'Login realizado com sucesso!',
        user: userService.toPublicUser(result.user),
        sessionToken: result.sessionToken,
        recoveryToken: result.recoveryToken,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to log in with keyfile');
      res.status(500).json({ message: LOGIN_FAILED_MESSAGE });
    }
  };

  const checkNicknameAvailability = async (req: Request, res: Response): Promise<void> => {
    const parsed = nicknameAvailabilityQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ message: 'Nickname é obrigatório!' });
      return;
    }

    const { nickname } = parsed.data;

    if (!isValidNicknameFormat(nickname)) {
      res.status(200).json({ status: 'invalid' });
      return;
    }

    try {
      const existing = await userService.getUserByNickname(nickname);
      res.status(200).json({ status: existing ? 'taken' : 'available' });
    } catch (error) {
      logger.error({ err: error }, 'Failed to check nickname availability');
      res.status(500).json({ message: 'Erro ao verificar nickname. Tente novamente!' });
    }
  };

  return { login, loginWithKeyfile, checkNicknameAvailability };
}
