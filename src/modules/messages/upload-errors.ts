import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { errorPayload } from '../../lib/app-error.js';
import type { UploadKind } from '../../lib/error-catalog.js';

export interface UploadErrorOptions {
  oversizeCode?: 'upload.invalidGifSize';
}

export function createUploadErrorHandler(kind: UploadKind, maxSize: string, { oversizeCode }: UploadErrorOptions = {}) {
  return function handleUploadError(err: unknown, _req: Request, res: Response, next: NextFunction): void {
    if (!(err instanceof multer.MulterError)) {
      next(err);
      return;
    }

    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json(oversizeCode ? errorPayload(oversizeCode) : errorPayload('upload.tooLarge', { kind, maxSize }));
      return;
    }

    res.status(400).json(errorPayload('upload.invalidType', { kind }));
  };
}
