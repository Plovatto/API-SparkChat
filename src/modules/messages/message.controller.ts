import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Request, Response } from 'express';
import { z } from 'zod';
import '../../docs/zod-extend.js';
import { audioObjectKey, fileObjectKey, gifObjectKey, imageObjectKey } from '../../config/paths.js';
import { errorPayload } from '../../lib/app-error.js';
import type { UploadKind } from '../../lib/error-catalog.js';
import type { ObjectStorage } from '../../storage/object-storage.js';
import { StorageQuotaExceededError, type StorageQuota } from '../../storage/storage-quota.js';
import type { UploadRegistry } from '../../storage/upload-registry.js';
import { verifyFileSignature } from './message.file-signature.js';
import {
  GIF_UPLOAD_TTL_MS,
  MAX_LIVE_GIF_BYTES,
  isAllowedGifUploadSize,
  isNeutralUpload,
  NEUTRAL_UPLOAD_EXTENSION,
  NEUTRAL_UPLOAD_MIME_TYPE,
} from './message.upload.js';

const INLINE_SAFE_FILE_EXTENSIONS = new Set(['.pdf', '.mp4', '.webm', '.mov', '.avi']);
const UPLOAD_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const MAX_USER_STORAGE_BYTES = 500 * 1024 * 1024;

function decodeOriginalFilename(originalname: string): string {
  return Buffer.from(originalname, 'latin1').toString('utf8');
}

function isEncryptedUpload(req: Request): boolean {
  const body: unknown = req.body;
  return typeof body === 'object' && body !== null && (body as Record<string, unknown>).encrypted === '1';
}

function withEncryptedMarker(url: string, encrypted: boolean): string {
  return encrypted ? `${url}?e2e=1` : url;
}

function attachmentDispositionFor(originalname: string): string | undefined {
  return INLINE_SAFE_FILE_EXTENSIONS.has(path.extname(originalname).toLowerCase()) ? undefined : 'attachment';
}

export const mediaUploadResponseSchema = z
  .object({
    url: z.string().openapi({ example: 'https://pub-xxxxxxxx.r2.dev/uploads/images/3f1b2c.png', description: 'URL pública do arquivo enviado' }),
    mimeType: z.string().optional().openapi({ example: 'image/png', description: 'Ausente em envios criptografados' }),
  })
  .openapi('MediaUploadResponse');

export const fileUploadResponseSchema = z
  .object({
    url: z.string().openapi({ example: 'https://pub-xxxxxxxx.r2.dev/uploads/files/3f1b2c.pdf', description: 'URL pública do arquivo enviado' }),
    name: z.string().optional().openapi({ example: 'relatorio.pdf', description: 'Nome original do arquivo; ausente em envios criptografados' }),
    mimeType: z.string().optional().openapi({ example: 'application/pdf', description: 'Ausente em envios criptografados' }),
    size: z.number().int().nonnegative().optional().openapi({ example: 204800, description: 'Tamanho em bytes; ausente em envios criptografados' }),
  })
  .openapi('FileUploadResponse');

interface UploadHandlerOptions<TResponse> {
  kind: UploadKind;
  buildKey: (filename: string) => string;
  buildResponse: (file: Express.Multer.File, url: string) => TResponse;
  contentDisposition?: (originalname: string) => string | undefined;
  validateFile?: (file: Express.Multer.File) => 'upload.invalidGifSize' | null;
  countsTowardUserQuota?: boolean;
  ttlMs?: number;
  maxExpiringBytes?: number;
}

function createUploadHandler<TResponse>(
  objectStorage: ObjectStorage,
  storageQuota: StorageQuota,
  uploadRegistry: UploadRegistry,
  { kind, buildKey, buildResponse, contentDisposition, validateFile, countsTowardUserQuota = true, ttlMs, maxExpiringBytes }: UploadHandlerOptions<TResponse>,
) {
  return async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    const uploaderId = req.authenticatedUser?.id;
    if (!uploaderId) {
      res.status(401).json(errorPayload('auth.required'));
      return;
    }

    if (!file) {
      res.status(400).json(errorPayload('upload.missingFile', { kind }));
      return;
    }

    const encrypted = isEncryptedUpload(req);
    if (!encrypted && isNeutralUpload(file)) {
      res.status(400).json(errorPayload('upload.invalidType', { kind }));
      return;
    }

    const invalidFileCode = validateFile?.(file) ?? null;
    if (invalidFileCode) {
      res.status(400).json(errorPayload(invalidFileCode));
      return;
    }

    if (countsTowardUserQuota && (await uploadRegistry.totalBytesFor(uploaderId)) + file.size > MAX_USER_STORAGE_BYTES) {
      res.status(507).json(errorPayload('upload.userQuotaExceeded'));
      return;
    }

    if (maxExpiringBytes !== undefined && (await uploadRegistry.expiringBytesFor(uploaderId)) + file.size > maxExpiringBytes) {
      res.status(507).json(errorPayload('upload.userQuotaExceeded'));
      return;
    }

    try {
      await storageQuota.ensureCapacity(file.size);
    } catch (err) {
      if (err instanceof StorageQuotaExceededError) {
        res.status(507).json(errorPayload('upload.quotaExceeded'));
        return;
      }
      throw err;
    }

    if (!encrypted && !verifyFileSignature(file.buffer, file.mimetype)) {
      res.status(400).json(errorPayload('upload.contentMismatch'));
      return;
    }

    const extension = encrypted ? NEUTRAL_UPLOAD_EXTENSION : path.extname(file.originalname).toLowerCase();
    const key = buildKey(`${randomUUID()}${extension}`);
    await objectStorage.putObject(key, file.buffer, {
      contentType: encrypted ? NEUTRAL_UPLOAD_MIME_TYPE : file.mimetype,
      contentDisposition: encrypted ? 'attachment' : contentDisposition?.(file.originalname),
      cacheControl: UPLOAD_CACHE_CONTROL,
    });
    const expiresAt = ttlMs === undefined ? null : new Date(Date.now() + ttlMs).toISOString();
    await uploadRegistry.register(key, uploaderId, file.size, { expiresAt });
    await storageQuota.recordUsage(file.size);

    const url = withEncryptedMarker(objectStorage.publicUrl(key), encrypted);
    res.status(201).json(encrypted ? { url } : buildResponse(file, url));
  };
}

export function createMessageController(objectStorage: ObjectStorage, storageQuota: StorageQuota, uploadRegistry: UploadRegistry) {
  return {
    uploadImage: createUploadHandler(objectStorage, storageQuota, uploadRegistry, {
      kind: 'image',
      buildKey: imageObjectKey,
      buildResponse: (file, url) => ({ url, mimeType: file.mimetype }),
    }),
    uploadAudio: createUploadHandler(objectStorage, storageQuota, uploadRegistry, {
      kind: 'audio',
      buildKey: audioObjectKey,
      buildResponse: (file, url) => ({ url, mimeType: file.mimetype }),
    }),
    uploadFile: createUploadHandler(objectStorage, storageQuota, uploadRegistry, {
      kind: 'file',
      buildKey: fileObjectKey,
      contentDisposition: attachmentDispositionFor,
      buildResponse: (file, url) => ({
        url,
        name: decodeOriginalFilename(file.originalname),
        mimeType: file.mimetype,
        size: file.size,
      }),
    }),
    uploadGif: createUploadHandler(objectStorage, storageQuota, uploadRegistry, {
      kind: 'gif',
      buildKey: gifObjectKey,
      buildResponse: (_file, url) => ({ url }),
      validateFile: (file) => (isAllowedGifUploadSize(file.size) ? null : 'upload.invalidGifSize'),
      countsTowardUserQuota: false,
      ttlMs: GIF_UPLOAD_TTL_MS,
      maxExpiringBytes: MAX_LIVE_GIF_BYTES,
    }),
  };
}
