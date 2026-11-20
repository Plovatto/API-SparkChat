import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './support/build-test-app.js';

const MAX_ATTEMPTS = 400;
const API_LIMIT_TIMEOUT_MS = 30_000;

async function sendUntilRateLimited(send: () => Promise<request.Response>): Promise<request.Response> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const response = await send();
    if (response.status === 429) {
      return response;
    }
  }

  throw new Error('rate limit was never reached');
}

describe('rate limiters', () => {
  it('answers the link preview limiter with rateLimit.linkPreview', async () => {
    const { app } = await buildTestApp();

    const response = await sendUntilRateLimited(() => request(app).post('/api/link-preview').send({ url: 'https://example.com' }));

    expect(response.body).toEqual({
      message: 'Muitas requisições de preview. Aguarde um momento e tente novamente.',
      code: 'rateLimit.linkPreview',
    });
  });

  it('answers the upload limiter with rateLimit.upload', async () => {
    const { app } = await buildTestApp();

    const response = await sendUntilRateLimited(() => request(app).post('/api/messages/upload-image'));

    expect(response.body).toEqual({
      message: 'Muitos envios de arquivo. Aguarde um momento e tente novamente.',
      code: 'rateLimit.upload',
    });

    const avatar = await request(app).post('/api/avatars/upload');
    expect(avatar.status).toBe(401);
  });

  it('gives avatar uploads their own upload limiter', async () => {
    const { app } = await buildTestApp();

    const response = await sendUntilRateLimited(() => request(app).post('/api/avatars/upload'));

    expect(response.body).toMatchObject({ code: 'rateLimit.upload' });
  });

  it('answers the global api limiter with rateLimit.api', async () => {
    const { app } = await buildTestApp();

    const response = await sendUntilRateLimited(() => request(app).get('/api/does-not-exist'));

    expect(response.body).toEqual({
      message: 'Muitas requisições em pouco tempo. Aguarde e tente novamente.',
      code: 'rateLimit.api',
    });
  }, API_LIMIT_TIMEOUT_MS);
});
