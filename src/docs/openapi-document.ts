import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { registry } from './registry.js';

export type OpenApiDocument = ReturnType<OpenApiGeneratorV3['generateDocument']>;

export function generateOpenApiDocument(): OpenApiDocument {
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
