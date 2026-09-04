import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { compressImageForModel } from '@/modules/ai/ai.media.js';

describe('compressImageForModel', () => {
  it('re-encodes a large image as a smaller jpeg', async () => {
    const original = await sharp({
      create: { width: 2000, height: 1500, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .png()
      .toBuffer();

    const { mimeType, data } = await compressImageForModel(original);
    const metadata = await sharp(data).metadata();

    expect(mimeType).toBe('image/jpeg');
    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBeLessThanOrEqual(768);
    expect(metadata.height).toBeLessThanOrEqual(768);
    expect(data.length).toBeLessThan(original.length);
  });
});
