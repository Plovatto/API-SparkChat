import { Router } from 'express';
import { errorResponseSchema } from '../../docs/common-schemas.js';
import { registry } from '../../docs/registry.js';
import {
  createUserController,
  loginBodySchema,
  loginResponseSchema,
  nicknameAvailabilityQuerySchema,
  nicknameAvailabilityResponseSchema,
} from './user.controller.js';
import { keyfileUpload } from './user.keyfile-upload.js';
import type { LoginRateLimiter } from './user.login-rate-limiter.js';
import type { UserService } from './user.service.js';

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
      description: 'Muitas tentativas de login',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/users/login-with-keyfile',
  tags: ['Users'],
  summary: 'Autentica um usuário a partir do arquivo binário de recuperação',
  request: {
    body: {
      content: { 'multipart/form-data': { schema: { type: 'object', properties: { keyfile: { type: 'string', format: 'binary' } } } } },
    },
  },
  responses: {
    200: {
      description: 'Login realizado com sucesso',
      content: { 'application/json': { schema: loginResponseSchema } },
    },
    400: {
      description: 'Arquivo não enviado',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    401: {
      description: 'Arquivo de recuperação inválido',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
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

export function createUserRouter(userService: UserService, loginRateLimiter: LoginRateLimiter): Router {
  const router = Router();
  const controller = createUserController(userService, loginRateLimiter);

  router.post('/login', (req, res) => {
    void controller.login(req, res);
  });

  router.post('/login-with-keyfile', keyfileUpload.single('keyfile'), (req, res) => {
    void controller.loginWithKeyfile(req, res);
  });

  router.get('/nickname-availability', (req, res) => {
    void controller.checkNicknameAvailability(req, res);
  });

  return router;
}
