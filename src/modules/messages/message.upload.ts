import path from 'node:path';
import multer from 'multer';
import { UPLOAD_PART_LIMITS } from './upload-concurrency.js';

export const NEUTRAL_UPLOAD_MIME_TYPE = 'application/octet-stream';
export const NEUTRAL_UPLOAD_EXTENSION = '.bin';

export function isNeutralUpload(file: Pick<Express.Multer.File, 'mimetype' | 'originalname'>): boolean {
  return file.mimetype === NEUTRAL_UPLOAD_MIME_TYPE && path.extname(file.originalname).toLowerCase() === NEUTRAL_UPLOAD_EXTENSION;
}

type UploadTypeCheck = (mimetype: string, extension: string) => boolean;

function allowsAnyPairing(allowedMimeTypes: ReadonlySet<string>, allowedExtensions: ReadonlySet<string>): UploadTypeCheck {
  return (mimetype, extension) => allowedMimeTypes.has(mimetype) && allowedExtensions.has(extension);
}

function createMediaUpload(isAllowedType: UploadTypeCheck, maxFileSizeBytes: number) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { ...UPLOAD_PART_LIMITS, fileSize: maxFileSizeBytes },
    fileFilter(_req, file, callback) {
      if (isNeutralUpload(file)) {
        callback(null, true);
        return;
      }

      if (!isAllowedType(file.mimetype, path.extname(file.originalname).toLowerCase())) {
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

const fileExtensionsByMimeType: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['application/pdf', new Set(['.pdf'])],
  ['video/mp4', new Set(['.mp4'])],
  ['video/webm', new Set(['.webm'])],
  ['video/quicktime', new Set(['.mov'])],
  ['video/x-msvideo', new Set(['.avi'])],
  ['application/msword', new Set(['.doc'])],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', new Set(['.docx'])],
  ['application/vnd.ms-excel', new Set(['.xls'])],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', new Set(['.xlsx'])],
  ['application/vnd.ms-powerpoint', new Set(['.ppt'])],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', new Set(['.pptx'])],
  ['application/zip', new Set(['.zip'])],
  ['application/x-zip-compressed', new Set(['.zip'])],
  ['text/plain', new Set(['.txt'])],
  ['text/csv', new Set(['.csv'])],
]);

function allowsMatchingFileType(mimetype: string, extension: string): boolean {
  return fileExtensionsByMimeType.get(mimetype)?.has(extension) === true;
}

const INLINE_SAFE_FILE_MIME_TYPES: ReadonlySet<string> = new Set(['application/pdf', 'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo']);

export function fileDispositionFor(mimetype: string): 'attachment' | undefined {
  return INLINE_SAFE_FILE_MIME_TYPES.has(mimetype) ? undefined : 'attachment';
}

export const maxImageSizeBytes = 5 * 1024 * 1024;
export const maxAudioSizeBytes = 8 * 1024 * 1024;
export const maxFileSizeBytes = 50 * 1024 * 1024;

export const imageUpload = createMediaUpload(allowsAnyPairing(allowedImageMimeTypes, allowedImageExtensions), maxImageSizeBytes);
export const audioUpload = createMediaUpload(allowsAnyPairing(allowedAudioMimeTypes, allowedAudioExtensions), maxAudioSizeBytes);
export const fileUpload = createMediaUpload(allowsMatchingFileType, maxFileSizeBytes);

const ENCRYPTION_OVERHEAD_BYTES = 40;
const GIF_PADDED_SIZE_STEPS = [256 * 1024, 512 * 1024, 1024 * 1024, 2 * 1024 * 1024];

export const GIF_UPLOAD_SIZES: readonly number[] = GIF_PADDED_SIZE_STEPS.map((step) => step + ENCRYPTION_OVERHEAD_BYTES);
export const GIF_UPLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_LIVE_GIF_BYTES = 200 * 1024 * 1024;

export function isAllowedGifUploadSize(size: number): boolean {
  return GIF_UPLOAD_SIZES.includes(size);
}

export const maxGifUploadBytes = Math.max(...GIF_UPLOAD_SIZES);

export const gifUpload = multer({
  storage: multer.memoryStorage(),
  limits: { ...UPLOAD_PART_LIMITS, fileSize: Math.max(...GIF_UPLOAD_SIZES) },
  fileFilter(_req, file, callback) {
    if (isNeutralUpload(file)) {
      callback(null, true);
      return;
    }
    callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
  },
});
