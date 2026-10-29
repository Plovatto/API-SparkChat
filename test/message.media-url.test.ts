import { describe, expect, it } from 'vitest';
import { isUploadedMediaUrl } from '@/modules/messages/message.socket.js';

describe('isUploadedMediaUrl', () => {
  it('accepts https urls inside the uploaded-media namespace', () => {
    expect(isUploadedMediaUrl('https://cdn.test/uploads/images/abc.png')).toBe(true);
    expect(isUploadedMediaUrl('https://cdn.test/uploads/audio/abc.webm?e2e=1')).toBe(true);
    expect(isUploadedMediaUrl('https://cdn.test/uploads/files/abc.pdf')).toBe(true);
  });

  it('rejects script and data urls even when the path looks like an upload', () => {
    expect(isUploadedMediaUrl('javascript:/uploads/files/abc.pdf')).toBe(false);
    expect(isUploadedMediaUrl('data:/uploads/files/abc.pdf')).toBe(false);
  });

  it('rejects insecure and relative urls', () => {
    expect(isUploadedMediaUrl('http://cdn.test/uploads/images/abc.png')).toBe(false);
    expect(isUploadedMediaUrl('/uploads/images/abc.png')).toBe(false);
  });

  it('rejects urls outside the uploaded-media namespace', () => {
    expect(isUploadedMediaUrl('https://cdn.test/secrets.env')).toBe(false);
    expect(isUploadedMediaUrl('https://cdn.test/uploads/images/nested/abc.png')).toBe(false);
  });
});
