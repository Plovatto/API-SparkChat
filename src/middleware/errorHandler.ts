import type { NextFunction, Request, Response } from 'express';
import { logger } from '../config/logger.js';
import { errorPayload, type ErrorPayload } from '../lib/app-error.js';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json(errorPayload('internal.routeNotFound', { method: req.method, path: req.originalUrl }));
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ message: 'Internal server error', code: 'internal.unexpected' } satisfies ErrorPayload);
}
