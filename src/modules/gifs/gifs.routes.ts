import { Router } from 'express';
import { errorResponseSchema } from '../../docs/common-schemas.js';
import { registry } from '../../docs/registry.js';
import { asyncHandler } from '../../middleware/async-handler.js';
import { createRequireAuth } from '../../middleware/auth.js';
import { createRateLimiter } from '../../middleware/rate-limit.js';
import type { UserService } from '../users/index.js';
import {
  createGifController,
  gifMediaRequestSchema,
  gifPageResponseSchema,
  gifSearchRequestSchema,
  gifStatusResponseSchema,
  gifTrendingRequestSchema,
} from './gifs.controller.js';
import type { GifProvider } from './gifs.provider.js';

const commonErrorResponses = {
  401: {
    description: 'Autenticação necessária ou sessão inválida',
    content: { 'application/json': { schema: errorResponseSchema } },
  },
  429: {
    description: 'Muitas requisições em pouco tempo',
    content: { 'application/json': { schema: errorResponseSchema } },
  },
  503: {
    description: 'Galeria de GIFs desligada',
    content: { 'application/json': { schema: errorResponseSchema } },
  },
};

const providerFailedResponse = {
  502: {
    description: 'O provedor de GIFs falhou',
    content: { 'application/json': { schema: errorResponseSchema } },
  },
};

registry.registerPath({
  method: 'get',
  path: '/api/gifs/status',
  tags: ['Gifs'],
  summary: 'Informa se a galeria de GIFs está ligada',
  security: [{ sessionAuth: [] }],
  responses: {
    200: { description: 'Estado da galeria', content: { 'application/json': { schema: gifStatusResponseSchema } } },
    401: commonErrorResponses[401],
    429: commonErrorResponses[429],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/gifs/trending',
  tags: ['Gifs'],
  summary: 'Lista os GIFs populares; os parâmetros vão no corpo para não aparecerem em logs',
  security: [{ sessionAuth: [] }],
  request: { body: { content: { 'application/json': { schema: gifTrendingRequestSchema } } } },
  responses: {
    200: { description: 'Página de GIFs', content: { 'application/json': { schema: gifPageResponseSchema } } },
    400: { description: 'Parâmetros inválidos', content: { 'application/json': { schema: errorResponseSchema } } },
    ...providerFailedResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/gifs/search',
  tags: ['Gifs'],
  summary: 'Pesquisa GIFs; o termo vai no corpo para não aparecer em logs',
  security: [{ sessionAuth: [] }],
  request: { body: { content: { 'application/json': { schema: gifSearchRequestSchema } } } },
  responses: {
    200: { description: 'Página de GIFs', content: { 'application/json': { schema: gifPageResponseSchema } } },
    400: { description: 'Busca inválida', content: { 'application/json': { schema: errorResponseSchema } } },
    ...providerFailedResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/gifs/media',
  tags: ['Gifs'],
  summary: 'Repassa os bytes (WEBP ou GIF, até 2 MB) de uma miniatura da galeria; só aceita URLs de mídia do provedor',
  security: [{ sessionAuth: [] }],
  request: { body: { content: { 'application/json': { schema: gifMediaRequestSchema } } } },
  responses: {
    200: { description: 'Bytes da imagem (image/webp ou image/gif)' },
    400: { description: 'URL de mídia inválida', content: { 'application/json': { schema: errorResponseSchema } } },
    ...providerFailedResponse,
    ...commonErrorResponses,
  },
});

export function createGifRouter(userService: UserService, provider: GifProvider | null): Router {
  const router = Router();
  const controller = createGifController(provider);
  const requireAuth = createRequireAuth(userService);
  const statusLimiter = createRateLimiter({ limit: 60, code: 'rateLimit.gifs', perUser: true });
  const listLimiter = createRateLimiter({ limit: 60, code: 'rateLimit.gifs', perUser: true });
  const mediaLimiter = createRateLimiter({ limit: 300, code: 'rateLimit.gifs', perUser: true });

  router.get('/status', requireAuth, statusLimiter, controller.status);
  router.post('/trending', requireAuth, listLimiter, asyncHandler(controller.trending));
  router.post('/search', requireAuth, listLimiter, asyncHandler(controller.search));
  router.post('/media', requireAuth, mediaLimiter, asyncHandler(controller.media));

  return router;
}
