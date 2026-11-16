import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryObjectStorage } from '@/storage/object-storage.js';
import { buildTestApp } from './support/build-test-app.js';

describe('GET /health', () => {
  it('reports the server as healthy with its uptime', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok' });
    expect((response.body as { uptime: number }).uptime).toBeGreaterThanOrEqual(0);
  });

  it('answers an unhandled failure with internal.unexpected keeping the original text', async () => {
    const objectStorage = new InMemoryObjectStorage();
    vi.spyOn(objectStorage, 'putObject').mockRejectedValue(new Error('bucket unavailable'));
    const { app, userService } = await buildTestApp({ objectStorage });
    const { user, sessionToken } = await userService.registerAccount({
      nickname: 'Crasher',
      avatar: 0,
      password: 'correct-horse-battery-staple',
    });

    const response = await request(app)
      .post('/api/messages/upload-image')
      .set('Authorization', `Bearer ${user.id}:${sessionToken}`)
      .attach('image', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        filename: 'photo.png',
        contentType: 'image/png',
      });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Internal server error', code: 'internal.unexpected' });
  });

  it('returns 404 as json for an unknown route', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).get('/api/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      message: 'Route not found: GET /api/does-not-exist',
      code: 'internal.routeNotFound',
      params: { method: 'GET', path: '/api/does-not-exist' },
    });
  });
});
