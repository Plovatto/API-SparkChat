import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import '../../docs/zod-extend.js';
import { avatarObjectKey } from '../../config/paths.js';
import { errorResponseSchema } from '../../docs/common-schemas.js';
import { registry } from '../../docs/registry.js';
import { errorPayload } from '../../lib/app-error.js';
import { asyncHandler } from '../../middleware/async-handler.js';
import { createRequireAuth } from '../../middleware/auth.js';
import type { ObjectStorage } from '../../storage/object-storage.js';
import type { StorageQuota } from '../../storage/storage-quota.js';
import type { UploadRegistry } from '../../storage/upload-registry.js';
import { createUploadHandler, isNeutralUpload, uploadRateLimiter } from '../messages/index.js';
import type { UserService } from '../users/index.js';
import { MAX_AVATAR_UPLOAD_BYTES } from './avatar.limits.js';

const AVATAR_MAX_SIZE_LABEL = '512KB';

export const avatarUploadResponseSchema = z
  .object({
    url: z.string().openapi({
      example: 'https://pub-xxxxxxxx.r2.dev/uploads/avatars/3f1b2c4d-0000-4000-8000-000000000000.bin?e2e=1',
      description: 'URL pública da foto criptografada; usar em user:set-avatar ou room:set-avatar',
    }),
  })
  .openapi('AvatarUploadResponse');

registry.registerPath({
  method: 'post',
  path: '/api/avatars/upload',
  tags: ['Avatars'],
  summary: 'Envia a foto de perfil ou de grupo já criptografada e retorna sua URL',
  security: [{ sessionAuth: [] }],
  request: {
    body: {
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            properties: {
              encrypted: { type: 'string', enum: ['1'] },
              image: { type: 'string', format: 'binary', description: 'Bytes cifrados, arquivo .bin com tipo application/octet-stream' },
            },
            required: ['encrypted', 'image'],
          },
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Foto armazenada sem dono; é apagada em 24h se não for usada',
      content: { 'application/json': { schema: avatarUploadResponseSchema } },
    },
    400: {
      description: 'Nenhuma foto enviada, envio não criptografado ou arquivo maior que 512KB',
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
    507: {
      description: 'Limite de armazenamento da conta ou do servidor atingido',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_UPLOAD_BYTES },
  fileFilter(_req, file, callback) {
    if (isNeutralUpload(file)) {
      callback(null, true);
      return;
    }
    callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
  },
});

function handleAvatarUploadError(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (!(err instanceof multer.MulterError)) {
    next(err);
    return;
  }

  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json(errorPayload('upload.tooLarge', { kind: 'avatar', maxSize: AVATAR_MAX_SIZE_LABEL }));
    return;
  }

  res.status(400).json(errorPayload('upload.invalidType', { kind: 'avatar' }));
}

export function createAvatarRouter(
  userService: UserService,
  objectStorage: ObjectStorage,
  storageQuota: StorageQuota,
  uploadRegistry: UploadRegistry,
): Router {
  const router = Router();
  const requireAuth = createRequireAuth(userService);
  const uploadAvatar = createUploadHandler(objectStorage, storageQuota, uploadRegistry, {
    kind: 'avatar',
    buildKey: avatarObjectKey,
    encryptedOnly: true,
    buildResponse: (_file, url) => ({ url }),
  });

  router.post('/upload', uploadRateLimiter, requireAuth, avatarUpload.single('image'), handleAvatarUploadError, asyncHandler(uploadAvatar));

  return router;
}
