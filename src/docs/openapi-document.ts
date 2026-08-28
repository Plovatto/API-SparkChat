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
        'API REST + Socket.IO do SparkChat. As rotas HTTP estão documentadas acima; os eventos de tempo real (Socket.IO) estão na seção "Eventos Socket.IO" logo abaixo, nesta mesma página.',
    },
    servers: [{ url: '/', description: 'Servidor atual' }],
  });
}
