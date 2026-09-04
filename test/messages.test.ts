import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { uploadsDir } from '../src/config/paths.js';
import { buildTestApp } from './support/build-test-app.js';

const { app, userService } = await buildTestApp();

let authHeader = '';

beforeAll(async () => {
  const { user, sessionToken } = await userService.registerAccount({
    nickname: 'Uploader',
    avatar: 0,
    password: 'correct-horse-battery-staple',
    socketId: 'socket-uploader',
  });
  authHeader = `Bearer ${user.id}:${sessionToken}`;
});

afterAll(async () => {
  await rm(uploadsDir, { recursive: true, force: true });
});

describe('Upload authentication', () => {
  it('rejects an upload without a session', async () => {
    const response = await request(app)
      .post('/api/messages/upload-image')
      .attach('image', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        filename: 'photo.png',
        contentType: 'image/png',
      });

    expect(response.status).toBe(401);
  });

  it('rejects an upload with an invalid session token', async () => {
    const response = await request(app)
      .post('/api/messages/upload-image')
      .set('Authorization', 'Bearer not-a-real-user:not-a-real-token')
      .attach('image', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        filename: 'photo.png',
        contentType: 'image/png',
      });

    expect(response.status).toBe(401);
  });
});

describe('POST /api/messages/upload-image', () => {
  it('stores a valid image and returns its url', async () => {
    const response = await request(app)
      .post('/api/messages/upload-image')
      .set('Authorization', authHeader)
      .attach('image', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        filename: 'photo.png',
        contentType: 'image/png',
      });

    const body = response.body as { url: string };
    expect(response.status).toBe(201);
    expect(body.url).toMatch(/^\/uploads\/images\/.+\.png$/);
  });

  it('rejects a request with no file', async () => {
    const response = await request(app).post('/api/messages/upload-image').set('Authorization', authHeader);

    expect(response.status).toBe(400);
  });

  it('rejects a non-image file', async () => {
    const response = await request(app)
      .post('/api/messages/upload-image')
      .set('Authorization', authHeader)
      .attach('image', Buffer.from('not an image'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(response.status).toBe(400);
  });

  it('rejects an image whose declared mimetype does not match its real content', async () => {
    const response = await request(app)
      .post('/api/messages/upload-image')
      .set('Authorization', authHeader)
      .attach('image', Buffer.from('this is not really a png'), { filename: 'fake.png', contentType: 'image/png' });

    expect(response.status).toBe(400);
  });

  it('rejects an image with a disguised extension even when the mimetype is spoofed to look allowed', async () => {
    const response = await request(app)
      .post('/api/messages/upload-image')
      .set('Authorization', authHeader)
      .attach('image', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        filename: 'evil.svg',
        contentType: 'image/png',
      });

    expect(response.status).toBe(400);
  });

  it('skips the content-signature check and marks the url when the upload is end-to-end encrypted', async () => {
    const response = await request(app)
      .post('/api/messages/upload-image')
      .set('Authorization', authHeader)
      .field('encrypted', '1')
      .attach('image', Buffer.from('this is opaque ciphertext, not a real png'), {
        filename: 'photo.png',
        contentType: 'image/png',
      });

    const body = response.body as { url: string };
    expect(response.status).toBe(201);
    expect(body.url).toMatch(/^\/uploads\/images\/.+\.png\?e2e=1$/);
  });

  it('still enforces the mimetype and extension allowlist for encrypted uploads', async () => {
    const response = await request(app)
      .post('/api/messages/upload-image')
      .set('Authorization', authHeader)
      .field('encrypted', '1')
      .attach('image', Buffer.from('ciphertext'), { filename: 'evil.exe', contentType: 'application/x-msdownload' });

    expect(response.status).toBe(400);
  });
});

describe('POST /api/messages/upload-audio', () => {
  it('stores a valid audio file and returns its url', async () => {
    const response = await request(app)
      .post('/api/messages/upload-audio')
      .set('Authorization', authHeader)
      .attach('audio', Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), { filename: 'clip.webm', contentType: 'audio/webm' });

    const body = response.body as { url: string };
    expect(response.status).toBe(201);
    expect(body.url).toMatch(/^\/uploads\/audio\/.+\.webm$/);
  });

  it('rejects a request with no file', async () => {
    const response = await request(app).post('/api/messages/upload-audio').set('Authorization', authHeader);

    expect(response.status).toBe(400);
  });

  it('rejects a non-audio file', async () => {
    const response = await request(app)
      .post('/api/messages/upload-audio')
      .set('Authorization', authHeader)
      .attach('audio', Buffer.from('not audio'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(response.status).toBe(400);
  });

  it('rejects an audio file whose declared mimetype does not match its real content', async () => {
    const response = await request(app)
      .post('/api/messages/upload-audio')
      .set('Authorization', authHeader)
      .attach('audio', Buffer.from('this is not really webm audio'), { filename: 'fake.webm', contentType: 'audio/webm' });

    expect(response.status).toBe(400);
  });
});

describe('POST /api/messages/upload-file', () => {
  it('stores a valid PDF and returns its url and metadata', async () => {
    const response = await request(app)
      .post('/api/messages/upload-file')
      .set('Authorization', authHeader)
      .attach('file', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]), {
        filename: 'relatorio.pdf',
        contentType: 'application/pdf',
      });

    const body = response.body as { url: string; name: string; mimeType: string; size: number };
    expect(response.status).toBe(201);
    expect(body.url).toMatch(/^\/uploads\/files\/.+\.pdf$/);
    expect(body.name).toBe('relatorio.pdf');
    expect(body.mimeType).toBe('application/pdf');
    expect(body.size).toBeGreaterThan(0);
  });

  it('preserves accented characters in the original filename', async () => {
    const response = await request(app)
      .post('/api/messages/upload-file')
      .set('Authorization', authHeader)
      .attach('file', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]), {
        filename: 'relatório.pdf',
        contentType: 'application/pdf',
      });

    const body = response.body as { name: string };
    expect(response.status).toBe(201);
    expect(body.name).toBe('relatório.pdf');
  });

  it('rejects a request with no file', async () => {
    const response = await request(app).post('/api/messages/upload-file').set('Authorization', authHeader);

    expect(response.status).toBe(400);
  });

  it('rejects a mimetype that is not in the allowed list', async () => {
    const response = await request(app)
      .post('/api/messages/upload-file')
      .set('Authorization', authHeader)
      .attach('file', Buffer.from('hello'), { filename: 'notes.exe', contentType: 'application/x-msdownload' });

    expect(response.status).toBe(400);
  });

  it('rejects a file whose declared mimetype does not match its real content', async () => {
    const response = await request(app)
      .post('/api/messages/upload-file')
      .set('Authorization', authHeader)
      .attach('file', Buffer.from('this is not really a pdf'), { filename: 'fake.pdf', contentType: 'application/pdf' });

    expect(response.status).toBe(400);
  });

  it('rejects a blocked extension even when the mimetype is spoofed to look allowed', async () => {
    const response = await request(app)
      .post('/api/messages/upload-file')
      .set('Authorization', authHeader)
      .attach('file', Buffer.from([0x25, 0x50, 0x44, 0x46]), { filename: 'virus.exe', contentType: 'application/pdf' });

    expect(response.status).toBe(400);
  });
});
