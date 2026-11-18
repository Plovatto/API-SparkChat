import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './support/build-test-app.js';

describe('malformed requests', () => {
  it('answers invalid JSON with 400 instead of 500', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).post('/api/users/login').set('Content-Type', 'application/json').send('{"nickname":');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'validation.invalidPayload' });
  });

  it('answers an unexpected multipart field with 400 instead of 500', async () => {
    const { app } = await buildTestApp();

    const response = await request(app)
      .post('/api/users/login-with-keyfile')
      .attach('not-the-keyfile', Buffer.from('x'), { filename: 'x.bin', contentType: 'application/octet-stream' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'validation.invalidPayload' });
  });
});
