import { describe, expect, it, vi } from 'vitest';
import { fetchProxiedImage, sniffRasterImageType } from '@/modules/link-preview/link-preview.image-proxy.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function imageResponse(body: Buffer, contentType: string): Response {
  return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': contentType } });
}

describe('sniffRasterImageType', () => {
  it('recognises the raster formats', () => {
    expect(sniffRasterImageType(PNG)).toBe('image/png');
    expect(sniffRasterImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffRasterImageType(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffRasterImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  });

  it('rejects SVG and anything else', () => {
    expect(sniffRasterImageType(SVG)).toBeNull();
    expect(sniffRasterImageType(Buffer.from('<html></html>'))).toBeNull();
  });
});

describe('fetchProxiedImage', () => {
  it('serves raster images with the sniffed content type', async () => {
    const transport = vi.fn().mockResolvedValue(imageResponse(PNG, 'application/octet-stream'));

    const image = await fetchProxiedImage('https://93.184.216.34/cover.png', { transport });

    expect(image?.contentType).toBe('image/png');
  });

  it('refuses SVG even when the server labels it as an image', async () => {
    const transport = vi.fn().mockResolvedValue(imageResponse(SVG, 'image/svg+xml'));

    const image = await fetchProxiedImage('https://93.184.216.34/cover.svg', { transport });

    expect(image).toBeNull();
  });
});
