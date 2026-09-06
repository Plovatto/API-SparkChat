import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { z } from 'zod';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { downloadButtonScript } from './docs/download-button.js';
import { generateOpenApiDocument } from './docs/openapi-document.js';
import { registry } from './docs/registry.js';
import { listSocketEvents } from './docs/socket-registry.js';
import { socketEventsPanelScript } from './docs/socket-events-panel.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { createApiRouter, type ApiRouterDeps } from './routes/index.js';

const healthResponseSchema = z
  .object({
    status: z.literal('ok'),
    uptime: z.number().openapi({ example: 123.45, description: 'Seconds since process start' }),
  })
  .openapi('HealthResponse');

const apiRateLimiter = createRateLimiter({
  limit: 300,
  message: 'Muitas requisições em pouco tempo. Aguarde e tente novamente.',
});

registry.registerPath({
  method: 'get',
  path: '/health',
  tags: ['System'],
  summary: 'Health check',
  responses: {
    200: {
      description: 'Servidor saudável',
      content: { 'application/json': { schema: healthResponseSchema } },
    },
  },
});

export function createApp(deps: ApiRouterDeps): Express {
  const app = express();

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
  app.use(express.json());
  app.use(
    pinoHttp({
      logger,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[redacted]',
      },
    }),
  );
  app.use('/api', apiRateLimiter);

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
  });

  app.use('/api', createApiRouter(deps));

  const openApiDocument = generateOpenApiDocument();
  app.get('/docs/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  app.get('/docs/download', (_req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="sparkchat-api.openapi.json"');
    res.json(openApiDocument);
  });
  app.get('/docs/download-button.js', (_req, res) => {
    res.type('application/javascript').send(downloadButtonScript);
  });
  app.get('/docs/socket-events.json', (_req, res) => {
    res.json(listSocketEvents());
  });
  app.get('/docs/socket-events-panel.js', (_req, res) => {
    res.type('application/javascript').send(socketEventsPanelScript);
  });
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      customJs: ['/docs/download-button.js', '/docs/socket-events-panel.js'],
      customSiteTitle: 'SparkChat API Docs',
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
