import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import type { OpenAPIObject } from 'openapi3-ts/oas30';
import { registry } from './registry.js';

export function generateOpenApiDocument(): OpenAPIObject {
  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'SparkChat API',
      version: '0.1.0',
      description:
        'API REST + Socket.IO do SparkChat. Este documento cobre apenas as rotas HTTP — os eventos de tempo real (Socket.IO) estão tipados e documentados em src/sockets/events.ts.',
    },
    servers: [{ url: '/', description: 'Servidor atual' }],
  });
}
