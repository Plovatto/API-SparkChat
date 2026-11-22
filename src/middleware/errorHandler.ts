import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { logger } from '../config/logger.js';
import { errorPayload, type ErrorPayload } from '../lib/app-error.js';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json(errorPayload('internal.routeNotFound', { method: req.method, path: req.originalUrl }));
}

function describeClientError(err: unknown, status: number): { type: string; status: number } {
  if (err instanceof multer.MulterError) {
    return { type: `multer.${err.code}`, status };
  }
  const { type } = err as { type?: unknown };
  return { type: typeof type === 'string' ? type : 'unknown', status };
}

function clientErrorStatus(err: unknown): number | null {
  if (err instanceof multer.MulterError) {
    return 400;
  }

  if (typeof err !== 'object' || err === null) {
    return null;
  }

  const { status, statusCode, type } = err as { status?: unknown; statusCode?: unknown; type?: unknown };
  const candidate = typeof status === 'number' ? status : statusCode;
  if (typeof type === 'string' && typeof candidate === 'number' && candidate >= 400 && candidate < 500) {
    return candidate;
  }

  return null;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const status = clientErrorStatus(err);
  if (status !== null) {
    logger.warn({ request: describeClientError(err, status) }, 'Rejected malformed request');
    res.status(status).json(errorPayload('validation.invalidPayload'));
    return;
  }

  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ message: 'Internal server error', code: 'internal.unexpected' } satisfies ErrorPayload);
}
