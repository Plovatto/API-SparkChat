import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './support/build-test-app.js';

describe('GET /health', () => {
  it('reports the server as healthy with its uptime', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok' });
    expect((response.body as { uptime: number }).uptime).toBeGreaterThanOrEqual(0);
  });

  it('returns 404 as json for an unknown route', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).get('/api/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Route not found: GET /api/does-not-exist' });
  });
});
