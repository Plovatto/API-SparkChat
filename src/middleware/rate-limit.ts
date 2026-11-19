import type { Request } from 'express';
import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import { errorPayload } from '../lib/app-error.js';
import type { ErrorCode } from '../lib/error-catalog.js';

const DEFAULT_WINDOW_MS = 60 * 1000;

type RateLimitErrorCode = Extract<ErrorCode, `rateLimit.${string}`>;

interface RateLimiterOptions {
  limit: number;
  code: RateLimitErrorCode;
  windowMs?: number;
  perUser?: boolean;
}

function authenticatedUserKey(req: Request): string {
  const userId = req.authenticatedUser?.id;
  return userId ? `user:${userId}` : `ip:${req.ip ?? 'unknown'}`;
}

export function createRateLimiter({ limit, code, windowMs = DEFAULT_WINDOW_MS, perUser = false }: RateLimiterOptions): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: errorPayload(code),
    ...(perUser ? { keyGenerator: authenticatedUserKey } : {}),
  });
}
