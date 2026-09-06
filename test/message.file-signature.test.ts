import { describe, expect, it } from 'vitest';
import { verifyFileSignature } from '../src/modules/messages/message.file-signature.js';

function buffer(bytes: number[] | Buffer): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

describe('verifyFileSignature', () => {
  it('accepts a real PDF signature', () => {
    expect(verifyFileSignature(buffer([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]), 'application/pdf')).toBe(true);
  });

  it('rejects a file with the wrong bytes claiming to be a PDF', () => {
    expect(verifyFileSignature(Buffer.from('MZ this is actually an executable'), 'application/pdf')).toBe(false);
  });

  it('accepts a real ZIP/DOCX signature', () => {
    const zipBytes = buffer([0x50, 0x4b, 0x03, 0x04]);
    expect(verifyFileSignature(zipBytes, 'application/zip')).toBe(true);
    expect(
      verifyFileSignature(zipBytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe(true);
  });

  it('accepts a real WEBM signature', () => {
    expect(verifyFileSignature(buffer([0x1a, 0x45, 0xdf, 0xa3]), 'video/webm')).toBe(true);
  });

  it('accepts an MP4 signature at its expected offset', () => {
    expect(
      verifyFileSignature(buffer([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), 'video/mp4'),
    ).toBe(true);
  });

  it('accepts a real PNG signature', () => {
    expect(verifyFileSignature(buffer([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png')).toBe(true);
  });

  it('rejects a file with the wrong bytes claiming to be a PNG', () => {
    expect(verifyFileSignature(Buffer.from('<svg onload=alert(1)>'), 'image/png')).toBe(false);
  });

  it('accepts a real WEBP signature', () => {
    expect(
      verifyFileSignature(buffer([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]), 'image/webp'),
    ).toBe(true);
  });

  it('accepts a real OGG audio signature', () => {
    expect(verifyFileSignature(buffer([0x4f, 0x67, 0x67, 0x53]), 'audio/ogg')).toBe(true);
  });

  it('rejects a mimetype with no known signature', () => {
    expect(verifyFileSignature(buffer([0x00, 0x00, 0x00, 0x00]), 'application/x-msdownload')).toBe(false);
  });

  it('accepts plain text without embedded binary bytes', () => {
    expect(verifyFileSignature(Buffer.from('nome,idade\nAda,30\n'), 'text/csv')).toBe(true);
  });

  it('rejects text/plain content that contains a null byte', () => {
    expect(verifyFileSignature(buffer([0x68, 0x69, 0x00, 0x62, 0x79, 0x65]), 'text/plain')).toBe(false);
  });
});
