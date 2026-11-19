import { z } from 'zod';
import { logger } from '../config/logger.js';
import { AppError, errorPayload, type ErrorPayload } from '../lib/app-error.js';

export function extractErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof AppError) {
    return error.toPayload();
  }

  if (error instanceof z.ZodError) {
    return { message: error.message, code: 'validation.invalidPayload' };
  }

  logger.error({ err: error }, 'Unexpected socket handler error');
  return errorPayload('internal.unexpected');
}
