import multer from 'multer';

const MAX_KEYFILE_SIZE_BYTES = 4096;

export const keyfileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_KEYFILE_SIZE_BYTES },
});
