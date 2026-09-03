import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyFileSignature } from '../src/modules/messages/message.file-signature.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sparkchat-file-sig-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeTempFile(bytes: number[] | Buffer): Promise<string> {
  const filePath = path.join(dir, 'upload.bin');
  await writeFile(filePath, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  return filePath;
}

describe('verifyFileSignature', () => {
  it('accepts a real PDF signature', async () => {
    const filePath = await writeTempFile([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    expect(await verifyFileSignature(filePath, 'application/pdf')).toBe(true);
  });

  it('rejects a file with the wrong bytes claiming to be a PDF', async () => {
    const filePath = await writeTempFile(Buffer.from('MZ this is actually an executable'));
    expect(await verifyFileSignature(filePath, 'application/pdf')).toBe(false);
  });

  it('accepts a real ZIP/DOCX signature', async () => {
    const filePath = await writeTempFile([0x50, 0x4b, 0x03, 0x04]);
    expect(await verifyFileSignature(filePath, 'application/zip')).toBe(true);
    expect(
      await verifyFileSignature(filePath, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe(true);
  });

  it('accepts a real WEBM signature', async () => {
    const filePath = await writeTempFile([0x1a, 0x45, 0xdf, 0xa3]);
    expect(await verifyFileSignature(filePath, 'video/webm')).toBe(true);
  });

  it('accepts an MP4 signature at its expected offset', async () => {
    const filePath = await writeTempFile([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(await verifyFileSignature(filePath, 'video/mp4')).toBe(true);
  });

  it('rejects a mimetype with no known signature', async () => {
    const filePath = await writeTempFile([0x00, 0x00, 0x00, 0x00]);
    expect(await verifyFileSignature(filePath, 'application/x-msdownload')).toBe(false);
  });

  it('accepts plain text without embedded binary bytes', async () => {
    const filePath = await writeTempFile(Buffer.from('nome,idade\nAda,30\n'));
    expect(await verifyFileSignature(filePath, 'text/csv')).toBe(true);
  });

  it('rejects text/plain content that contains a null byte', async () => {
    const filePath = await writeTempFile(Buffer.from([0x68, 0x69, 0x00, 0x62, 0x79, 0x65]));
    expect(await verifyFileSignature(filePath, 'text/plain')).toBe(false);
  });
});
