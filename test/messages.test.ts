import { rm } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { uploadsDir } from '../src/config/paths.js';
import { LoginRateLimiter, UserRepository, UserService, UserSessionRepository } from '../src/modules/users/index.js';
import { createTestDb } from './support/create-test-db.js';
import { TEST_RECOVERY_FILE_SECRET } from './support/test-constants.js';

const db = await createTestDb();
const userRepository = new UserRepository(db);
const userSessionRepository = new UserSessionRepository(db);
const userService = new UserService(userRepository, userSessionRepository, TEST_RECOVERY_FILE_SECRET);
const loginRateLimiter = new LoginRateLimiter();
const app = createApp({ userService, loginRateLimiter });

afterAll(async () => {
  await rm(uploadsDir, { recursive: true, force: true });
});

describe('POST /api/messages/upload-image', () => {
  it('stores a valid image and returns its url', async () => {
    const response = await request(app)
      .post('/api/messages/upload-image')
      .attach('image', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'photo.png', contentType: 'image/png' });

    const body = response.body as { url: string };
    expect(response.status).toBe(201);
    expect(body.url).toMatch(/^\/uploads\/images\/.+\.png$/);
  });

  it('rejects a request with no file', async () => {
    const response = await request(app).post('/api/messages/upload-image');

    expect(response.status).toBe(400);
  });

  it('rejects a non-image file', async () => {
    const response = await request(app)
      .post('/api/messages/upload-image')
      .attach('image', Buffer.from('not an image'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(response.status).toBe(400);
  });
});

describe('POST /api/messages/upload-audio', () => {
  it('stores a valid audio file and returns its url', async () => {
    const response = await request(app)
      .post('/api/messages/upload-audio')
      .attach('audio', Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), { filename: 'clip.webm', contentType: 'audio/webm' });

    const body = response.body as { url: string };
    expect(response.status).toBe(201);
    expect(body.url).toMatch(/^\/uploads\/audio\/.+\.webm$/);
  });

  it('rejects a request with no file', async () => {
    const response = await request(app).post('/api/messages/upload-audio');

    expect(response.status).toBe(400);
  });

  it('rejects a non-audio file', async () => {
    const response = await request(app)
      .post('/api/messages/upload-audio')
      .attach('audio', Buffer.from('not audio'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(response.status).toBe(400);
  });
});
