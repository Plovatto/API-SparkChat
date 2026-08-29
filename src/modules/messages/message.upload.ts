import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { audioUploadDir, imagesUploadDir } from '../../config/paths.js';

function createMediaUpload(destination: string, allowedMimeTypes: Set<string>, maxFileSizeBytes: number) {
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

const maxImageSizeBytes = 5 * 1024 * 1024;
const maxAudioSizeBytes = 8 * 1024 * 1024;

export const imageUpload = createMediaUpload(imagesUploadDir, allowedImageMimeTypes, maxImageSizeBytes);
export const audioUpload = createMediaUpload(audioUploadDir, allowedAudioMimeTypes, maxAudioSizeBytes);
