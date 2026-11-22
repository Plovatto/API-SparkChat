import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { errorResponseSchema } from '../../docs/common-schemas.js';
import { registry } from '../../docs/registry.js';
import { AppError, errorPayload } from '../../lib/app-error.js';
import { asyncHandler } from '../../middleware/async-handler.js';
import { createRateLimiter } from '../../middleware/rate-limit.js';

export type CallDeclineHandler = (input: { callId: string; token: string }) => Promise<void>;

const declineRateLimiter = createRateLimiter({
  limit: 30,
  code: 'rateLimit.api',
});

export const callDeclineRequestSchema = z
  .object({
    callId: z.string().min(1).max(64).openapi({ example: 'b0Yx1b3k2mQe9n0pQkzA7w' }),
    token: z.string().min(1).max(512).openapi({ description: 'Token de recusa recebido na notificação push da chamada' }),
  })
  .openapi('CallDeclineRequest');

registry.registerPath({
  method: 'post',
  path: '/api/calls/decline',
  tags: ['Calls'],
  summary: 'Recusa uma chamada tocando a partir da notificação push, sem sessão aberta',
  request: {
    body: { content: { 'application/json': { schema: callDeclineRequestSchema } } },
  },
  responses: {
    204: { description: 'Chamada recusada (ou já encerrada)' },
    400: { description: 'Dados inválidos', content: { 'application/json': { schema: errorResponseSchema } } },
    403: { description: 'Token inválido ou expirado', content: { 'application/json': { schema: errorResponseSchema } } },
    404: { description: 'Chamada não encontrada', content: { 'application/json': { schema: errorResponseSchema } } },
  },
});

const STATUS_BY_CODE: Partial<Record<string, number>> = {
  'call.notAllowed': 403,
  'call.notFound': 404,
  'call.invalidState': 409,
  'call.disabled': 503,
};

export function createCallRouter(decline: CallDeclineHandler): Router {
  const router = Router();

  router.post(
    '/decline',
    declineRateLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = callDeclineRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(errorPayload('validation.invalidPayload'));
        return;
      }
      try {
        await decline(parsed.data);
      } catch (err) {
        const status = err instanceof AppError ? STATUS_BY_CODE[err.code] : undefined;
        if (err instanceof AppError && status !== undefined) {
          res.status(status).json(err.toPayload());
          return;
        }
        throw err;
      }
      res.status(204).end();
    }),
  );

  return router;
}
