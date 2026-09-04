import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';

const DEFAULT_WINDOW_MS = 60 * 1000;

interface RateLimiterOptions {
  limit: number;
  message: string;
  windowMs?: number;
}

export function createRateLimiter({ limit, message, windowMs = DEFAULT_WINDOW_MS }: RateLimiterOptions): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    message: { message },
  });
}
