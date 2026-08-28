import { Router } from 'express';
import { errorResponseSchema } from '../../docs/common-schemas.js';
import { registry } from '../../docs/registry.js';
import { createUserController, validateCodeBodySchema, validateCodeResponseSchema } from './user.controller.js';
import type { UserService } from './user.service.js';

registry.registerPath({
  method: 'post',
  path: '/api/users/validate-code',
  tags: ['Users'],
  summary: 'Valida um código de login e retorna o usuário correspondente',
  request: {
    body: {
      content: { 'application/json': { schema: validateCodeBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Código válido',
      content: { 'application/json': { schema: validateCodeResponseSchema } },
    },
    400: {
      description: 'loginCode não enviado no corpo da requisição',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'loginCode não corresponde a nenhum usuário',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

export function createUserRouter(userService: UserService): Router {
  const router = Router();
  const controller = createUserController(userService);

  router.post('/validate-code', (req, res) => {
    void controller.validateLoginCode(req, res);
  });

  return router;
}
