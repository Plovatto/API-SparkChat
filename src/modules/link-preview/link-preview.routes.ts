import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { errorResponseSchema } from '../../docs/common-schemas.js';
import { registry } from '../../docs/registry.js';
import { createRequireAuth } from '../../middleware/auth.js';
import type { UserService } from '../users/index.js';
import { createLinkPreviewController, linkPreviewRequestSchema, linkPreviewResponseSchema } from './link-preview.controller.js';
import type { LinkPreviewService } from './link-preview.service.js';

const linkPreviewRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { message: 'Muitas requisições de preview. Aguarde um momento e tente novamente.' },
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
      description: 'Autenticação necessÃ¡ria ou sessão inválida',
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
      description: 'Autenticação necessÃ¡ria ou sessão inválida',
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
  const withAuth = (req: Request, res: Response, next: NextFunction) => void requireAuth(req, res, next);

  router.post('/', linkPreviewRateLimiter, withAuth, (req: Request, res: Response) => void controller.getPreview(req, res));
  router.get('/image', linkPreviewRateLimiter, withAuth, (req: Request, res: Response) => void controller.getImage(req, res));

  return router;
}
