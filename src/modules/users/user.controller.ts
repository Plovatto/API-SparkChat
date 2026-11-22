import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { errorPayload } from '../../lib/app-error.js';
import { isValidNicknameFormat, NICKNAME_MAX_LENGTH, nicknameAvailabilityStatusSchema, publicUserSchema } from './user.model.js';
import { PasswordCapacityError } from './user.password.js';
import type { LoginRateLimiter } from './user.login-rate-limiter.js';
import type { UserService } from './user.service.js';
import type { SessionRevocationNotifier } from './user.session-revocations.js';

const NICKNAME_INPUT_MAX_LENGTH = NICKNAME_MAX_LENGTH * 4;
const PASSWORD_INPUT_MAX_LENGTH = 128;

export const nicknameAvailabilityQuerySchema = z
  .object({
    nickname: z.string().trim().min(1).max(NICKNAME_INPUT_MAX_LENGTH).openapi({ example: 'Ada' }),
  })
  .openapi('NicknameAvailabilityQuery');

export const nicknameAvailabilityResponseSchema = z
  .object({
    status: nicknameAvailabilityStatusSchema,
  })
  .openapi('NicknameAvailabilityResponse');

export const loginBodySchema = z
  .object({
    nickname: z.string().trim().min(1).max(NICKNAME_INPUT_MAX_LENGTH).openapi({ example: 'Ada' }),
    password: z.string().min(1).max(PASSWORD_INPUT_MAX_LENGTH).openapi({
      example: 'q1w2e3r4t5y6u7i8o9p0q1w2e3r4t5y6u7i8o9p0abc',
      description: 'Chave de autenticação derivada no cliente (Argon2id), base64url sem padding (32 bytes); outros formatos são recusados com 401',
    }),
  })
  .openapi('LoginBody');

const authVersionSchema = z.literal(2).openapi({
  example: 2,
  description: 'Versão das credenciais da conta: sempre 2 (chave derivada no cliente)',
});

export const loginResponseSchema = z
  .object({
    message: z.string().openapi({ example: 'Login realizado com sucesso!' }),
    user: publicUserSchema,
    sessionToken: z.string().openapi({ example: 'a1b2c3...' }),
    authVersion: authVersionSchema,
  })
  .openapi('LoginResponse');

export const authParamsBodySchema = z
  .object({
    nickname: z.string().trim().min(1).max(NICKNAME_INPUT_MAX_LENGTH).openapi({ example: 'Ada' }),
  })
  .openapi('AuthParamsBody');

export const authParamsResponseSchema = z
  .object({
    version: z.literal(2),
    salt: z.string().openapi({ example: 'q1w2e3r4t5y6u7i8o9p0aa', description: 'Salt Argon2id em base64url sem padding (16 bytes)' }),
  })
  .openapi('AuthParamsResponse');

export const recoveryLoginBodySchema = z
  .object({
    userId: z.string().trim().min(1).max(64).openapi({ example: '3e3f4a1e-3b7a-4f7b-8f2a-2b7a7b9b2b2a' }),
    recoveryKey: z.string().min(1).max(200).openapi({ example: 'q1w2e3r4t5y6u7i8o9p0q1w2e3r4t5y6u7i8o9p0abc', description: 'Chave derivada do segredo do arquivo de recuperação v2, base64url sem padding (32 bytes)' }),
  })
  .openapi('RecoveryLoginBody');

export function createUserController(
  userService: UserService,
  loginRateLimiter: LoginRateLimiter,
  sessionRevocations: SessionRevocationNotifier,
) {
  const login = async (req: Request, res: Response): Promise<void> => {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(errorPayload('auth.missingCredentials'));
      return;
    }

    const { nickname, password } = parsed.data;
    const ip = req.ip ?? 'unknown';

    if (!loginRateLimiter.reserveAttempt(nickname, ip)) {
      res.status(429).json(errorPayload('rateLimit.loginAttempts'));
      return;
    }

    try {
      const result = await userService.login(nickname, password, req.headers['user-agent'] ?? '');
      if (!result) {
        res.status(401).json(errorPayload('auth.invalidCredentials'));
        return;
      }

      loginRateLimiter.registerSuccess(nickname, ip);
      res.status(200).json({
        message: 'Login realizado com sucesso!',
        user: userService.toPublicUser(result.user),
        sessionToken: result.sessionToken,
        authVersion: 2,
      });
    } catch (error) {
      loginRateLimiter.releaseAttempt(nickname, ip);
      if (error instanceof PasswordCapacityError) {
        res.setHeader('Retry-After', '1');
        res.status(429).json(errorPayload('rateLimit.api'));
        return;
      }
      logger.error({ err: error }, 'Failed to log in');
      res.status(500).json(errorPayload('auth.loginFailed'));
    }
  };

  const loginWithRecovery = async (req: Request, res: Response): Promise<void> => {
    const parsed = recoveryLoginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(errorPayload('auth.keyfileRequired'));
      return;
    }

    const ip = req.ip ?? 'unknown';

    if (!loginRateLimiter.reserveAttemptByIp(ip)) {
      res.status(429).json(errorPayload('rateLimit.loginAttempts'));
      return;
    }

    try {
      const result = await userService.loginWithRecovery(parsed.data.userId, parsed.data.recoveryKey, req.headers['user-agent'] ?? '');
      if (!result) {
        res.status(401).json(errorPayload('auth.keyfileInvalid'));
        return;
      }

      loginRateLimiter.registerSuccessByIp(ip);
      res.status(200).json({
        message: 'Login realizado com sucesso!',
        user: userService.toPublicUser(result.user),
        sessionToken: result.sessionToken,
        authVersion: 2,
      });
    } catch (error) {
      loginRateLimiter.releaseAttemptByIp(ip);
      logger.error({ err: error }, 'Failed to log in with recovery key');
      res.status(500).json(errorPayload('auth.loginFailed'));
    }
  };

  const getAuthParams = async (req: Request, res: Response): Promise<void> => {
    const parsed = authParamsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(errorPayload('user.nicknameRequired'));
      return;
    }

    if (!loginRateLimiter.reserveAuthParamsLookup(req.ip ?? 'unknown')) {
      res.status(429).json(errorPayload('rateLimit.loginAttempts'));
      return;
    }

    try {
      res.status(200).json(await userService.getAuthParams(parsed.data.nickname));
    } catch (error) {
      logger.error({ err: error }, 'Failed to read auth params');
      res.status(500).json(errorPayload('auth.loginFailed'));
    }
  };

  const checkNicknameAvailability = async (req: Request, res: Response): Promise<void> => {
    const parsed = nicknameAvailabilityQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(errorPayload('user.nicknameRequired'));
      return;
    }

    const { nickname } = parsed.data;

    if (!isValidNicknameFormat(nickname)) {
      res.status(200).json({ status: 'invalid' });
      return;
    }

    if (!loginRateLimiter.reserveNicknameAvailabilityLookup(req.ip ?? 'unknown')) {
      res.status(429).json(errorPayload('rateLimit.loginAttempts'));
      return;
    }

    try {
      const existing = await userService.getUserByNickname(nickname);
      res.status(200).json({ status: existing ? 'taken' : 'available' });
    } catch (error) {
      logger.error({ err: error }, 'Failed to check nickname availability');
      res.status(500).json(errorPayload('user.nicknameCheckFailed'));
    }
  };

  const logout = async (req: Request, res: Response): Promise<void> => {
    const userId = req.authenticatedUser?.id;
    const sessionId = req.authenticatedSessionId;
    if (!userId || !sessionId) {
      res.status(401).json(errorPayload('auth.required'));
      return;
    }

    await userService.revokeSession(userId, sessionId);
    sessionRevocations.publish({ userId, sessionId });
    res.status(204).end();
  };

  return { login, loginWithRecovery, getAuthParams, checkNicknameAvailability, logout };
}
