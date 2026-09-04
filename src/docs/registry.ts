import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import './zod-extend.js';

export const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'sessionAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: '<userId>:<sessionToken>',
  description: 'Token de sessão obtido no login, enviado como "Bearer <userId>:<sessionToken>"',
});
