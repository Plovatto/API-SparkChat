import type { NextFunction, Request, Response } from 'express';
import { logger } from '../config/logger.js';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ message: 'Internal server error' });
}
