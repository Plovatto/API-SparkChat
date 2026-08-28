import './zod-extend.js';
import { z } from 'zod';

export const errorResponseSchema = z
  .object({
    message: z.string().openapi({ example: 'Mensagem de erro' }),
  })
  .openapi('ErrorResponse');

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
