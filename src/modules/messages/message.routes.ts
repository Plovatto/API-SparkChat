import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import multer from 'multer';
import type { z } from 'zod';
import { errorResponseSchema } from '../../docs/common-schemas.js';
import { registry } from '../../docs/registry.js';
import { errorPayload } from '../../lib/app-error.js';
import type { UploadKind } from '../../lib/error-catalog.js';
import { asyncHandler } from '../../middleware/async-handler.js';
import { createRequireAuth } from '../../middleware/auth.js';
import { createRateLimiter } from '../../middleware/rate-limit.js';
import type { ObjectStorage } from '../../storage/object-storage.js';
import type { StorageQuota } from '../../storage/storage-quota.js';
import type { UploadRegistry } from '../../storage/upload-registry.js';
import type { UserService } from '../users/index.js';
import {
  createMessageController,
  fileUploadResponseSchema,
  mediaUploadResponseSchema,
} from './message.controller.js';
import {
  audioUpload,
  fileUpload,
  gifUpload,
  imageUpload,
  maxAudioSizeBytes,
  maxFileSizeBytes,
  maxGifUploadBytes,
  maxImageSizeBytes,
} from './message.upload.js';
import { createUploadConcurrencyGuard, sharedUploadLimiter } from './upload-concurrency.js';

const uploadRateLimiter = createRateLimiter({
  limit: 20,
  code: 'rateLimit.upload',
});

const uploadPerUserLimiter = createRateLimiter({
  limit: 20,
  code: 'rateLimit.upload',
  perUser: true,
});

const gifUploadPerMinuteLimiter = createRateLimiter({
  limit: 30,
  code: 'rateLimit.gifUpload',
  perUser: true,
});

const gifUploadPerDayLimiter = createRateLimiter({
  limit: 600,
  windowMs: 24 * 60 * 60 * 1000,
  code: 'rateLimit.gifUpload',
  perUser: true,
});

function registerUploadPath(
  path: string,
  fieldName: 'image' | 'audio' | 'file' | 'gif',
  summary: string,
  maxSizeDescription: string,
  responseSchema: z.ZodTypeAny,
): void {
  registry.registerPath({
    method: 'post',
    path,
    tags: ['Messages'],
    summary,
    security: [{ sessionAuth: [] }],
    request: {
      body: {
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: { [fieldName]: { type: 'string', format: 'binary' } },
              required: [fieldName],
            },
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Arquivo armazenado com sucesso',
        content: { 'application/json': { schema: responseSchema } },
      },
      400: {
        description: maxSizeDescription,
        content: { 'application/json': { schema: errorResponseSchema } },
      },
      401: {
        description: 'Autenticação necessária ou sessão inválida',
        content: { 'application/json': { schema: errorResponseSchema } },
      },
      429: {
        description: 'Muitos envios em pouco tempo',
        content: { 'application/json': { schema: errorResponseSchema } },
      },
    },
  });
}

registerUploadPath(
  '/api/messages/upload-image',
  'image',
  'Envia uma imagem e retorna sua URL para uso em uma mensagem do tipo image',
  'Nenhuma imagem enviada, tipo de arquivo inválido ou arquivo maior que 5MB',
  mediaUploadResponseSchema,
);
registerUploadPath(
  '/api/messages/upload-audio',
  'audio',
  'Envia um áudio e retorna sua URL para uso em uma mensagem do tipo audio',
  'Nenhum áudio enviado, tipo de arquivo inválido ou arquivo maior que 8MB',
  mediaUploadResponseSchema,
);
registerUploadPath(
  '/api/messages/upload-file',
  'file',
  'Envia um arquivo (PDF, vídeo, documento, etc) e retorna sua URL e metadados para uso em uma mensagem do tipo file',
  'Nenhum arquivo enviado, tipo de arquivo inválido ou arquivo maior que 50MB',
  fileUploadResponseSchema,
);
registerUploadPath(
  '/api/messages/upload/gif',
  'gif',
  'Envia um GIF já criptografado (application/octet-stream, extensão .bin, campo encrypted=1) e retorna sua URL para uso em uma mensagem do tipo image; o GIF expira em 30 dias e não conta na cota do usuário',
  'Nenhum GIF enviado, envio não criptografado ou tamanho diferente de 256 KiB, 512 KiB, 1 MiB ou 2 MiB mais 40 bytes',
  mediaUploadResponseSchema,
);

function createUploadErrorHandler(kind: UploadKind, maxSize: string) {
  return function handleUploadError(err: unknown, _req: Request, res: Response, next: NextFunction): void {
    if (!(err instanceof multer.MulterError)) {
      next(err);
      return;
    }

    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json(errorPayload('upload.tooLarge', { kind, maxSize }));
      return;
    }

    res.status(400).json(errorPayload('upload.invalidType', { kind }));
  };
}

const imageUploadGuard = createUploadConcurrencyGuard(sharedUploadLimiter, 'image', '5MB', { maxBytesPerUpload: maxImageSizeBytes });
const audioUploadGuard = createUploadConcurrencyGuard(sharedUploadLimiter, 'audio', '8MB', { maxBytesPerUpload: maxAudioSizeBytes });
const fileUploadGuard = createUploadConcurrencyGuard(sharedUploadLimiter, 'file', '50MB', { maxBytesPerUpload: maxFileSizeBytes });
const gifUploadGuard = createUploadConcurrencyGuard(sharedUploadLimiter, 'gif', '2MB', {
  maxBytesPerUpload: maxGifUploadBytes,
  oversizeCode: 'upload.invalidGifSize',
});

const handleImageUploadError = createUploadErrorHandler('image', '5MB');
const handleAudioUploadError = createUploadErrorHandler('audio', '8MB');
const handleFileUploadError = createUploadErrorHandler('file', '50MB');

function handleGifUploadError(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (!(err instanceof multer.MulterError)) {
    next(err);
    return;
  }

  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json(errorPayload('upload.invalidGifSize'));
    return;
  }

  res.status(400).json(errorPayload('upload.invalidType', { kind: 'gif' }));
}

export function createMessageRouter(
  userService: UserService,
  objectStorage: ObjectStorage,
  storageQuota: StorageQuota,
  uploadRegistry: UploadRegistry,
): Router {
  const router = Router();
  const controller = createMessageController(objectStorage, storageQuota, uploadRegistry);
  const requireAuth = createRequireAuth(userService);

  router.post(
    '/upload-image',
    uploadRateLimiter,
    requireAuth,
    uploadPerUserLimiter,
    imageUploadGuard,
    imageUpload.single('image'),
    handleImageUploadError,
    asyncHandler(controller.uploadImage),
  );

  router.post(
    '/upload-audio',
    uploadRateLimiter,
    requireAuth,
    uploadPerUserLimiter,
    audioUploadGuard,
    audioUpload.single('audio'),
    handleAudioUploadError,
    asyncHandler(controller.uploadAudio),
  );

  router.post(
    '/upload-file',
    uploadRateLimiter,
    requireAuth,
    uploadPerUserLimiter,
    fileUploadGuard,
    fileUpload.single('file'),
    handleFileUploadError,
    asyncHandler(controller.uploadFile),
  );

  router.post(
    '/upload/gif',
    requireAuth,
    gifUploadPerMinuteLimiter,
    gifUploadPerDayLimiter,
    gifUploadGuard,
    gifUpload.single('gif'),
    handleGifUploadError,
    asyncHandler(controller.uploadGif),
  );

  return router;
}
