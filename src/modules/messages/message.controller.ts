import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Request, Response } from 'express';
import { z } from 'zod';
import '../../docs/zod-extend.js';
import { audioObjectKey, fileObjectKey, imageObjectKey } from '../../config/paths.js';
import { errorPayload } from '../../lib/app-error.js';
import type { UploadKind } from '../../lib/error-catalog.js';
import type { ObjectStorage } from '../../storage/object-storage.js';
import { StorageQuotaExceededError, type StorageQuota } from '../../storage/storage-quota.js';
import { verifyFileSignature } from './message.file-signature.js';

const INLINE_SAFE_FILE_EXTENSIONS = new Set(['.pdf', '.mp4', '.webm', '.mov', '.avi']);
const UPLOAD_CACHE_CONTROL = 'public, max-age=31536000, immutable';

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
    mimeType: z.string().openapi({ example: 'image/png' }),
  })
  .openapi('MediaUploadResponse');

export const fileUploadResponseSchema = z
  .object({
    url: z.string().openapi({ example: 'https://pub-xxxxxxxx.r2.dev/uploads/files/3f1b2c.pdf', description: 'URL pública do arquivo enviado' }),
    name: z.string().openapi({ example: 'relatorio.pdf', description: 'Nome original do arquivo' }),
    mimeType: z.string().openapi({ example: 'application/pdf' }),
    size: z.number().int().nonnegative().openapi({ example: 204800, description: 'Tamanho em bytes' }),
  })
  .openapi('FileUploadResponse');

interface UploadHandlerOptions<TResponse> {
  kind: UploadKind;
  buildKey: (filename: string) => string;
  buildResponse: (file: Express.Multer.File, url: string) => TResponse;
  contentDisposition?: (originalname: string) => string | undefined;
}

function createUploadHandler<TResponse>(
  objectStorage: ObjectStorage,
  storageQuota: StorageQuota,
  { kind, buildKey, buildResponse, contentDisposition }: UploadHandlerOptions<TResponse>,
) {
  return async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) {
      res.status(400).json(errorPayload('upload.missingFile', { kind }));
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

    const encrypted = isEncryptedUpload(req);
    if (!encrypted && !verifyFileSignature(file.buffer, file.mimetype)) {
      res.status(400).json(errorPayload('upload.contentMismatch'));
      return;
    }

    const filename = `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`;
    const key = buildKey(filename);
    await objectStorage.putObject(key, file.buffer, {
      contentType: file.mimetype,
      contentDisposition: contentDisposition?.(file.originalname),
      cacheControl: UPLOAD_CACHE_CONTROL,
    });
    await storageQuota.recordUsage(file.size);

    res.status(201).json(buildResponse(file, withEncryptedMarker(objectStorage.publicUrl(key), encrypted)));
  };
}

export function createMessageController(objectStorage: ObjectStorage, storageQuota: StorageQuota) {
  return {
    uploadImage: createUploadHandler(objectStorage, storageQuota, {
      kind: 'image',
      buildKey: imageObjectKey,
      buildResponse: (file, url) => ({ url, mimeType: file.mimetype }),
    }),
    uploadAudio: createUploadHandler(objectStorage, storageQuota, {
      kind: 'audio',
      buildKey: audioObjectKey,
      buildResponse: (file, url) => ({ url, mimeType: file.mimetype }),
    }),
    uploadFile: createUploadHandler(objectStorage, storageQuota, {
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
  };
}
