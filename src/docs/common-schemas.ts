import './zod-extend.js';
import { z } from 'zod';
import { ERROR_CODES } from '../lib/error-catalog.js';

export const errorParamsSchema = z
  .record(z.string(), z.union([z.string(), z.number()]))
  .openapi({
    example: { kind: 'audio', maxSize: '8MB' },
    description: 'Valores usados no texto, presentes só quando o texto tem valores',
  });

export const errorPayloadSchema = z.object({
  message: z.string().openapi({ example: 'Esse nickname já está em uso.', description: 'Texto reserva em português' }),
  code: z.enum(ERROR_CODES).openapi({ example: 'user.nicknameTaken', description: 'Código estável para tradução no cliente' }),
  params: errorParamsSchema.optional(),
});

export const errorResponseSchema = errorPayloadSchema.openapi('ErrorResponse');
