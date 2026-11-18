import sharp from 'sharp';
import { AI_IMAGE_JPEG_QUALITY, AI_MAX_IMAGE_DIMENSION, AI_MAX_IMAGE_INPUT_PIXELS } from './ai.model.js';

export interface CompressedImage {
  mimeType: string;
  data: Buffer;
}

export async function compressImageForModel(buffer: Buffer): Promise<CompressedImage> {
  const data = await sharp(buffer, { limitInputPixels: AI_MAX_IMAGE_INPUT_PIXELS })
    .rotate()
    .resize({
      width: AI_MAX_IMAGE_DIMENSION,
      height: AI_MAX_IMAGE_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: AI_IMAGE_JPEG_QUALITY })
    .toBuffer();

  return { mimeType: 'image/jpeg', data };
}
