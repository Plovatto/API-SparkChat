import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { errorPayload } from '../../lib/app-error.js';
import type { UploadKind } from '../../lib/error-catalog.js';

export const MAX_UPLOADS_IN_FLIGHT_PER_USER = 2;
export const MAX_UPLOADS_IN_FLIGHT = 16;
export const MAX_UPLOAD_BYTES_IN_FLIGHT = 256 * 1024 * 1024;
export const MULTIPART_OVERHEAD_ALLOWANCE_BYTES = 64 * 1024;

export const UPLOAD_PART_LIMITS = {
  files: 1,
  fields: 2,
  parts: 3,
  fieldSize: 1024,
  fieldNameSize: 100,
  headerPairs: 20,
} as const;

interface UploadConcurrencyOptions {
  maxBytesPerUpload: number;
  oversizeCode?: 'upload.invalidGifSize';
  maxPerUser?: number;
  maxTotal?: number;
  maxTotalBytes?: number;
}

export class UploadConcurrencyLimiter {
  private readonly perUser = new Map<string, number>();
  private total = 0;
  private totalBytes = 0;

  constructor(
    private readonly maxPerUser: number = MAX_UPLOADS_IN_FLIGHT_PER_USER,
    private readonly maxTotal: number = MAX_UPLOADS_IN_FLIGHT,
    private readonly maxTotalBytes: number = MAX_UPLOAD_BYTES_IN_FLIGHT,
  ) {}

  tryAcquire(userId: string, bytes: number): (() => void) | null {
    const current = this.perUser.get(userId) ?? 0;
    if (current >= this.maxPerUser || this.total >= this.maxTotal || this.totalBytes + bytes > this.maxTotalBytes) {
      return null;
    }
    this.perUser.set(userId, current + 1);
    this.total += 1;
    this.totalBytes += bytes;

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.total -= 1;
      this.totalBytes -= bytes;
      const remaining = (this.perUser.get(userId) ?? 1) - 1;
      if (remaining <= 0) {
        this.perUser.delete(userId);
      } else {
        this.perUser.set(userId, remaining);
      }
    };
  }

  inFlight(): number {
    return this.total;
  }
}

function declaredLength(req: Request): number | null {
  const header = req.headers['content-length'];
  if (typeof header !== 'string' || !/^\d+$/.test(header)) {
    return null;
  }
  return Number(header);
}

export function createUploadConcurrencyGuard(
  limiter: UploadConcurrencyLimiter,
  kind: UploadKind,
  maxSize: string,
  { maxBytesPerUpload, oversizeCode }: UploadConcurrencyOptions,
): RequestHandler {
  const ceiling = maxBytesPerUpload + MULTIPART_OVERHEAD_ALLOWANCE_BYTES;

  return (req: Request, res: Response, next: NextFunction): void => {
    const userId = req.authenticatedUser?.id;
    if (!userId) {
      res.status(401).json(errorPayload('auth.required'));
      return;
    }

    const declared = declaredLength(req);
    if (declared !== null && declared > ceiling) {
      res.status(400).json(oversizeCode ? errorPayload(oversizeCode) : errorPayload('upload.tooLarge', { kind, maxSize }));
      return;
    }

    const release = limiter.tryAcquire(userId, declared ?? ceiling);
    if (!release) {
      res.status(429).json(errorPayload('rateLimit.upload'));
      return;
    }

    res.once('close', release);
    next();
  };
}

export const sharedUploadLimiter = new UploadConcurrencyLimiter();
