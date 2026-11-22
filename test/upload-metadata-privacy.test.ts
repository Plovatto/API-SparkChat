import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { InMemoryObjectStorage, type PutObjectOptions } from '@/storage/object-storage.js';
import { buildTestApp } from './support/build-test-app.js';
import { TEST_V2_SIGNUP } from './support/test-constants.js';

class RecordingObjectStorage extends InMemoryObjectStorage {
  readonly writes: { key: string; options: PutObjectOptions }[] = [];

  override putObject(key: string, body: Buffer, options: PutObjectOptions): Promise<void> {
    this.writes.push({ key, options });
    return super.putObject(key, body, options);
  }
}

const CIPHERTEXT = Buffer.from('opaque ciphertext that matches no file signature');

async function setup() {
  const objectStorage = new RecordingObjectStorage();
  const { app, userService } = await buildTestApp({ objectStorage });
  const { user, sessionToken } = await userService.registerAccount({ nickname: 'Private', avatar: 0, password: 'correct-horse-battery-staple-0123456789abcd', ...TEST_V2_SIGNUP });
  return { app, objectStorage, authHeader: `Bearer ${user.id}:${sessionToken}` };
}

const ROUTES = [
  { path: '/api/messages/upload-image', field: 'image', folder: 'images' },
  { path: '/api/messages/upload-audio', field: 'audio', folder: 'audio' },
  { path: '/api/messages/upload-file', field: 'file', folder: 'files' },
] as const;

describe('encrypted uploads keep attachment metadata private', () => {
  for (const route of ROUTES) {
    it(`accepts a neutral ciphertext on ${route.path} and stores it without the client name or type`, async () => {
      const { app, objectStorage, authHeader } = await setup();

      const response = await request(app)
        .post(route.path)
        .set('Authorization', authHeader)
        .field('encrypted', '1')
        .attach(route.field, CIPHERTEXT, { filename: 'blob.bin', contentType: 'application/octet-stream' });

      expect(response.status).toBe(201);
      const body = response.body as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(['url']);
      expect(body.url).toMatch(new RegExp(`^https://fake-object-storage\\.test/uploads/${route.folder}/[0-9a-f-]+\\.bin\\?e2e=1$`));
      expect(objectStorage.writes).toHaveLength(1);
      expect(objectStorage.writes[0]?.options).toEqual({
        contentType: 'application/octet-stream',
        contentDisposition: 'attachment',
        cacheControl: 'public, max-age=31536000, immutable',
      });
    });
  }

  it('accepts the encrypted flag even when it arrives after the file part', async () => {
    const { app, objectStorage, authHeader } = await setup();

    const response = await request(app)
      .post('/api/messages/upload-file')
      .set('Authorization', authHeader)
      .attach('file', CIPHERTEXT, { filename: 'blob.bin', contentType: 'application/octet-stream' })
      .field('encrypted', '1');

    expect(response.status).toBe(201);
    expect(objectStorage.writes[0]?.key).toMatch(/^uploads\/files\/[0-9a-f-]+\.bin$/);
  });

  it('ignores the real name and type that older clients still send with encrypted uploads', async () => {
    const { app, objectStorage, authHeader } = await setup();

    const response = await request(app)
      .post('/api/messages/upload-file')
      .set('Authorization', authHeader)
      .field('encrypted', '1')
      .attach('file', CIPHERTEXT, { filename: 'salário-2026.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ url: expect.stringMatching(/\.bin\?e2e=1$/) as unknown });
    expect(objectStorage.writes[0]?.key).toMatch(/^uploads\/files\/[0-9a-f-]+\.bin$/);
    expect(objectStorage.writes[0]?.options.contentType).toBe('application/octet-stream');
    expect(JSON.stringify(objectStorage.writes[0])).not.toContain('sal');
  });

  it('rejects a neutral file that is not marked as encrypted and stores nothing', async () => {
    const { app, objectStorage, authHeader } = await setup();

    const response = await request(app)
      .post('/api/messages/upload-image')
      .set('Authorization', authHeader)
      .attach('image', CIPHERTEXT, { filename: 'blob.bin', contentType: 'application/octet-stream' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'upload.invalidType', params: { kind: 'image' } });
    expect(objectStorage.writes).toHaveLength(0);
  });

  it('keeps the plaintext upload response and storage metadata for legacy clients', async () => {
    const { app, objectStorage, authHeader } = await setup();

    const response = await request(app)
      .post('/api/messages/upload-file')
      .set('Authorization', authHeader)
      .attach('file', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]), { filename: 'notes.txt.pdf', contentType: 'application/pdf' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ name: 'notes.txt.pdf', mimeType: 'application/pdf', size: 8 });
    expect(objectStorage.writes[0]?.key).toMatch(/^uploads\/files\/[0-9a-f-]+\.pdf$/);
    expect(objectStorage.writes[0]?.options.contentType).toBe('application/pdf');
  });
});

describe('plaintext file uploads derive type and disposition together', () => {
  const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

  it('rejects a text body declared as text/plain but named .pdf', async () => {
    const { app, objectStorage, authHeader } = await setup();

    const response = await request(app)
      .post('/api/messages/upload-file')
      .set('Authorization', authHeader)
      .attach('file', Buffer.from('<h1>Pay here</h1>'), { filename: 'invoice.pdf', contentType: 'text/plain' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'upload.invalidType', params: { kind: 'file' } });
    expect(objectStorage.writes).toHaveLength(0);
  });

  it('rejects a PDF body named as a video', async () => {
    const { app, objectStorage, authHeader } = await setup();

    const response = await request(app)
      .post('/api/messages/upload-file')
      .set('Authorization', authHeader)
      .attach('file', PDF_BYTES, { filename: 'clip.mp4', contentType: 'application/pdf' });

    expect(response.status).toBe(400);
    expect(objectStorage.writes).toHaveLength(0);
  });

  it('serves a verified PDF inline', async () => {
    const { app, objectStorage, authHeader } = await setup();

    const response = await request(app)
      .post('/api/messages/upload-file')
      .set('Authorization', authHeader)
      .attach('file', PDF_BYTES, { filename: 'report.PDF', contentType: 'application/pdf' });

    expect(response.status).toBe(201);
    expect(objectStorage.writes[0]?.options).toMatchObject({ contentType: 'application/pdf', contentDisposition: undefined });
  });

  it('forces text files to download as attachments', async () => {
    const { app, objectStorage, authHeader } = await setup();

    const response = await request(app)
      .post('/api/messages/upload-file')
      .set('Authorization', authHeader)
      .attach('file', Buffer.from('plain notes'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(response.status).toBe(201);
    expect(objectStorage.writes[0]?.options).toMatchObject({ contentType: 'text/plain', contentDisposition: 'attachment' });
  });
});
