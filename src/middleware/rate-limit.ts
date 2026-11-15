import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import { errorPayload } from '../lib/app-error.js';
import type { ErrorCode } from '../lib/error-catalog.js';

const DEFAULT_WINDOW_MS = 60 * 1000;

type RateLimitErrorCode = Extract<ErrorCode, `rateLimit.${string}`>;

interface RateLimiterOptions {
  limit: number;
  code: RateLimitErrorCode;
  windowMs?: number;
}

export function createRateLimiter({ limit, code, windowMs = DEFAULT_WINDOW_MS }: RateLimiterOptions): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: errorPayload(code),
  });
}
