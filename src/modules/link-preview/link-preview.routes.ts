import { Router } from 'express';
import { errorResponseSchema } from '../../docs/common-schemas.js';
import { registry } from '../../docs/registry.js';
import { asyncHandler } from '../../middleware/async-handler.js';
import { createRequireAuth } from '../../middleware/auth.js';
import { createRateLimiter } from '../../middleware/rate-limit.js';
import type { UserService } from '../users/index.js';
import { createLinkPreviewController, linkPreviewRequestSchema, linkPreviewResponseSchema } from './link-preview.controller.js';
import type { LinkPreviewService } from './link-preview.service.js';

const linkPreviewRateLimiter = createRateLimiter({
  limit: 30,
  message: 'Muitas requisições de preview. Aguarde um momento e tente novamente.',
});

registry.registerPath({
  method: 'post',
  path: '/api/link-preview',
  tags: ['LinkPreview'],
  summary: 'Busca metadata (Open Graph) de uma URL para exibir um preview no chat',
  security: [{ sessionAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: linkPreviewRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Metadata da URL',
      content: { 'application/json': { schema: linkPreviewResponseSchema } },
    },
    400: {
      description: 'URL ausente ou inválida',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    401: {
      description: 'Autenticação necessária ou sessão inválida',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    422: {
      description: 'Não foi possível gerar preview para a URL informada',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    429: {
      description: 'Muitas requisições em pouco tempo',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/link-preview/image',
  tags: ['LinkPreview'],
  summary: 'Repassa (proxy) os bytes da imagem de um preview de link, sem expor o IP do cliente ao site de origem',
  security: [{ sessionAuth: [] }],
  request: {
    query: linkPreviewRequestSchema,
  },
  responses: {
    200: { description: 'Bytes da imagem' },
    400: {
      description: 'URL ausente ou inválida',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    401: {
      description: 'Autenticação necessária ou sessão inválida',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    422: {
      description: 'Não foi possível carregar a imagem',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

export function createLinkPreviewRouter(userService: UserService, service: LinkPreviewService): Router {
  const router = Router();
  const controller = createLinkPreviewController(service);
  const requireAuth = createRequireAuth(userService);

  router.post('/', linkPreviewRateLimiter, requireAuth, asyncHandler(controller.getPreview));
  router.get('/image', linkPreviewRateLimiter, requireAuth, asyncHandler(controller.getImage));

  return router;
}
