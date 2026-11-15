import { z } from 'zod';
import { AppError, errorPayload, type ErrorPayload } from '../lib/app-error.js';

export function extractErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof AppError) {
    return error.toPayload();
  }

  if (error instanceof z.ZodError) {
    return { message: error.message, code: 'validation.invalidPayload' };
  }

  if (error instanceof Error) {
    return { message: error.message, code: 'internal.unexpected' };
  }

  return errorPayload('internal.unexpected');
}
