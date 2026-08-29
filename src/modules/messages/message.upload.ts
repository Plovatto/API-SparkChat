import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { imagesUploadDir } from '../../config/paths.js';

const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const maxFileSizeBytes = 5 * 1024 * 1024;

const storage = multer.diskStorage({
  destination(_req, _file, callback) {
    mkdirSync(imagesUploadDir, { recursive: true });
    callback(null, imagesUploadDir);
  },
  filename(_req, file, callback) {
    callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
  },
});

export const imageUpload = multer({
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
