import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { audioUploadDir, filesUploadDir, imagesUploadDir } from '../../config/paths.js';

function createMediaUpload(
  destination: string,
  allowedMimeTypes: Set<string>,
  allowedExtensions: Set<string>,
  maxFileSizeBytes: number,
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
      if (!allowedExtensions.has(extension)) {
        callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
        return;
      }

      callback(null, true);
    },
  });
}

const allowedImageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const allowedImageExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

const allowedAudioMimeTypes = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
]);
const allowedAudioExtensions = new Set(['.webm', '.ogg', '.oga', '.mp4', '.m4a', '.aac', '.mp3', '.wav']);

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

const allowedFileExtensions = new Set([
  '.pdf',
  '.mp4',
  '.webm',
  '.mov',
  '.avi',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.zip',
  '.txt',
  '.csv',
]);

const maxImageSizeBytes = 5 * 1024 * 1024;
const maxAudioSizeBytes = 8 * 1024 * 1024;
const maxFileSizeBytes = 50 * 1024 * 1024;

export const imageUpload = createMediaUpload(imagesUploadDir, allowedImageMimeTypes, allowedImageExtensions, maxImageSizeBytes);
export const audioUpload = createMediaUpload(audioUploadDir, allowedAudioMimeTypes, allowedAudioExtensions, maxAudioSizeBytes);
export const fileUpload = createMediaUpload(filesUploadDir, allowedFileMimeTypes, allowedFileExtensions, maxFileSizeBytes);
