import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { audioUploadDir, filesUploadDir, imagesUploadDir } from '../../config/paths.js';

function createMediaUpload(
  destination: string,
  allowedMimeTypes: Set<string>,
  maxFileSizeBytes: number,
  blockedExtensions?: Set<string>,
) {
  const storage = multer.diskStorage({
    destination(_req, _file, callback) {
      mkdirSync(destination, { recursive: true });
      callback(null, destination);
    },
    filename(_req, file, callback) {
      callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
    },
  });

  return multer({
    storage,
    limits: { fileSize: maxFileSizeBytes },
    fileFilter(_req, file, callback) {
      if (!allowedMimeTypes.has(file.mimetype)) {
        callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
        return;
      }

      const extension = path.extname(file.originalname).toLowerCase();
      if (blockedExtensions?.has(extension)) {
        callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
        return;
      }

      callback(null, true);
    },
  });
}

const allowedImageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const allowedAudioMimeTypes = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
]);

const allowedFileMimeTypes = new Set([
  'application/pdf',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain',
  'text/csv',
]);

const blockedFileExtensions = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.scr',
  '.msi',
  '.dll',
  '.app',
  '.sh',
  '.ps1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.jar',
  '.apk',
  '.html',
  '.htm',
  '.svg',
]);

const maxImageSizeBytes = 5 * 1024 * 1024;
const maxAudioSizeBytes = 8 * 1024 * 1024;
const maxFileSizeBytes = 50 * 1024 * 1024;

export const imageUpload = createMediaUpload(imagesUploadDir, allowedImageMimeTypes, maxImageSizeBytes);
export const audioUpload = createMediaUpload(audioUploadDir, allowedAudioMimeTypes, maxAudioSizeBytes);
export const fileUpload = createMediaUpload(filesUploadDir, allowedFileMimeTypes, maxFileSizeBytes, blockedFileExtensions);
