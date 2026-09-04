import sharp from 'sharp';
import { AI_IMAGE_JPEG_QUALITY, AI_MAX_IMAGE_DIMENSION } from './ai.model.js';

export interface CompressedImage {
  mimeType: string;
  data: Buffer;
}

export async function compressImageForModel(buffer: Buffer): Promise<CompressedImage> {
  const data = await sharp(buffer)
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
