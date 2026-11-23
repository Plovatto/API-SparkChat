import { Router } from 'express';
import { errorResponseSchema } from '../../docs/common-schemas.js';
import { registry } from '../../docs/registry.js';
import { asyncHandler } from '../../middleware/async-handler.js';
import { createRequireAuth } from '../../middleware/auth.js';
import {
  authParamsBodySchema,
  authParamsResponseSchema,
  createUserController,
  deviceKeyBodySchema,
  deviceKeyResponseSchema,
  loginBodySchema,
  loginResponseSchema,
  nicknameAvailabilityQuerySchema,
  nicknameAvailabilityResponseSchema,
  recoveryLoginBodySchema,
} from './user.controller.js';
import type { LoginRateLimiter } from './user.login-rate-limiter.js';
import type { UserService } from './user.service.js';
import type { SessionRevocationNotifier } from './user.session-revocations.js';

registry.registerPath({
  method: 'post',
  path: '/api/users/login',
  tags: ['Users'],
  summary: 'Autentica um usuário por nickname e senha',
  request: {
    body: {
      content: { 'application/json': { schema: loginBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Login realizado com sucesso',
      content: { 'application/json': { schema: loginResponseSchema } },
    },
    400: {
      description: 'Nickname ou senha não enviados',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    401: {
      description: 'Nickname ou senha inválidos',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    429: {
      description: 'Muitas tentativas de login (rateLimit.loginAttempts) ou atraso progressivo da conta (rateLimit.accountAttempts, com Retry-After)',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/users/login-with-recovery',
  tags: ['Users'],
  summary: 'Autentica um usuário com a chave derivada do arquivo de recuperação v2, montado e lido só no navegador',
  request: {
    body: {
      content: { 'application/json': { schema: recoveryLoginBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Login realizado com sucesso',
      content: { 'application/json': { schema: loginResponseSchema } },
    },
    400: {
      description: 'userId ou recoveryKey não enviados',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    401: {
      description: 'Chave de recuperação inválida',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    429: {
      description: 'Muitas tentativas de login',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/users/auth-params',
  tags: ['Users'],
  summary: 'Informa a versão das credenciais e o salt de derivação da senha de um nickname',
  description: 'Nicknames inexistentes recebem um salt falso determinístico para não revelar se a conta existe.',
  request: {
    body: {
      content: { 'application/json': { schema: authParamsBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Parâmetros de autenticação',
      content: { 'application/json': { schema: authParamsResponseSchema } },
    },
    400: {
      description: 'Nickname não enviado',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    429: {
      description: 'Muitas consultas a partir do mesmo IP',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/users/logout',
  tags: ['Users'],
  summary: 'Encerra a sessão atual e desconecta os sockets ligados a ela',
  security: [{ sessionAuth: [] }],
  responses: {
    204: {
      description: 'Sessão encerrada',
    },
    401: {
      description: 'Token de sessão ausente, inválido ou expirado',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/users/session/device-key',
  tags: ['Users'],
  summary: 'Liga a sessão atual à chave pública do dispositivo (migração de sessões antigas)',
  description:
    'Exige os cabeçalhos x-spark-timestamp, x-spark-nonce e x-spark-signature assinados com a chave enviada. Depois de ligada, toda requisição autenticada e o user:join precisam ser assinados por essa chave.',
  security: [{ sessionAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: deviceKeyBodySchema } } },
  },
  responses: {
    200: {
      description: 'Chave ligada (bound) ou já ligada a esta sessão (unchanged)',
      content: { 'application/json': { schema: deviceKeyResponseSchema } },
    },
    400: { description: 'Chave inválida', content: { 'application/json': { schema: errorResponseSchema } } },
    401: { description: 'Sessão ou assinatura inválida', content: { 'application/json': { schema: errorResponseSchema } } },
    403: { description: 'Modo obrigatório: sessões antigas precisam de novo login', content: { 'application/json': { schema: errorResponseSchema } } },
    409: { description: 'A sessão já está ligada a outra chave', content: { 'application/json': { schema: errorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/users/nickname-availability',
  tags: ['Users'],
  summary: 'Verifica se um nickname está disponível para cadastro',
  request: {
    query: nicknameAvailabilityQuerySchema,
  },
  responses: {
    200: {
      description: 'Status de disponibilidade do nickname',
      content: { 'application/json': { schema: nicknameAvailabilityResponseSchema } },
    },
    400: {
      description: 'Nickname não enviado',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

export function createUserRouter(
  userService: UserService,
  loginRateLimiter: LoginRateLimiter,
  sessionRevocations: SessionRevocationNotifier,
): Router {
  const router = Router();
  const controller = createUserController(userService, loginRateLimiter, sessionRevocations);
  router.post('/login', asyncHandler(controller.login));
  router.post('/login-with-recovery', asyncHandler(controller.loginWithRecovery));
  router.post('/auth-params', asyncHandler(controller.getAuthParams));
  router.post('/logout', createRequireAuth(userService, { allowUnsigned: true }), asyncHandler(controller.logout));
  router.post('/session/device-key', asyncHandler(controller.registerDeviceKey));
  router.get('/nickname-availability', asyncHandler(controller.checkNicknameAvailability));

  return router;
}
