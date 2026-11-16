import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { encryptedLength, LINK_PREVIEW_ENCRYPTED_LIMITS, type LinkPreviewFetcher, type LinkPreviewMetadata } from '@/modules/link-preview/index.js';
import { buildTestApp } from './support/build-test-app.js';

const PAGE_URL = 'https://example.com/article';
const METADATA: LinkPreviewMetadata = {
  url: PAGE_URL,
  title: 'Um artigo interessante',
  description: 'Resumo do artigo.',
  imageUrl: 'https://example.com/cover.jpg',
  siteName: 'Example',
};

function createCountingFetcher(result: LinkPreviewMetadata | null): { fetcher: LinkPreviewFetcher; calls: () => number } {
  let calls = 0;
  return {
    fetcher: {
      fetchMetadata: (url: string) => {
        calls += 1;
        return Promise.resolve(url === PAGE_URL ? result : null);
      },
    },
    calls: () => calls,
  };
}

describe('POST /api/link-preview', () => {
  it('rejects a request without a session', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).post('/api/link-preview').send({ url: PAGE_URL });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ message: 'Autenticação necessária.', code: 'auth.required' });
  });

  it('rejects a body that is not a valid URL', async () => {
    const { app, authHeader } = await setupAuthedApp();

    const response = await request(app).post('/api/link-preview').set('Authorization', authHeader).send({ url: 'not-a-url' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'URL inválida.', code: 'linkPreview.invalidUrl' });
  });

  it('returns metadata for a valid URL', async () => {
    const { fetcher } = createCountingFetcher(METADATA);
    const { app, authHeader } = await setupAuthedApp(fetcher);

    const response = await request(app).post('/api/link-preview').set('Authorization', authHeader).send({ url: PAGE_URL });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(METADATA);
  });

  it('returns 422 when the fetcher cannot produce metadata', async () => {
    const { fetcher } = createCountingFetcher(null);
    const { app, authHeader } = await setupAuthedApp(fetcher);

    const response = await request(app).post('/api/link-preview').set('Authorization', authHeader).send({ url: PAGE_URL });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({ message: 'Não foi possível gerar um preview para essa URL.', code: 'linkPreview.unavailable' });
  });

  it('serves a second request from cache without calling the fetcher again', async () => {
    const { fetcher, calls } = createCountingFetcher(METADATA);
    const { app, authHeader } = await setupAuthedApp(fetcher);

    await request(app).post('/api/link-preview').set('Authorization', authHeader).send({ url: PAGE_URL });
    const second = await request(app).post('/api/link-preview').set('Authorization', authHeader).send({ url: PAGE_URL });

    expect(second.status).toBe(200);
    expect(calls()).toBe(1);
  });

  it('trims fetched metadata so every field fits the message schema once encrypted', async () => {
    const { fetcher } = createCountingFetcher({
      ...METADATA,
      title: 'Título '.repeat(1000),
      description: 'ação 🎉 '.repeat(2000),
      siteName: '日本'.repeat(1000),
      imageUrl: `https://example.com/${'i'.repeat(4000)}.jpg`,
    });
    const { app, authHeader } = await setupAuthedApp(fetcher);

    const response = await request(app).post('/api/link-preview').set('Authorization', authHeader).send({ url: PAGE_URL });
    const body = response.body as LinkPreviewMetadata;

    expect(response.status).toBe(200);
    expect(encryptedLength(body.title)).toBeLessThanOrEqual(LINK_PREVIEW_ENCRYPTED_LIMITS.title);
    expect(encryptedLength(body.description ?? '')).toBeLessThanOrEqual(LINK_PREVIEW_ENCRYPTED_LIMITS.description);
    expect(encryptedLength(body.siteName ?? '')).toBeLessThanOrEqual(LINK_PREVIEW_ENCRYPTED_LIMITS.siteName);
    expect(body.imageUrl).toBeNull();
  });

  it('trims an oversized preview that was cached before the limits existed', async () => {
    const { fetcher, calls } = createCountingFetcher(METADATA);
    const { app, authHeader, linkPreviewRepository } = await setupAuthedApp(fetcher);
    await linkPreviewRepository.upsert({
      url: PAGE_URL,
      status: 'ok',
      title: 'T'.repeat(5000),
      description: 'd'.repeat(9000),
      imageUrl: METADATA.imageUrl,
      siteName: 'S'.repeat(2000),
      fetchedAt: new Date().toISOString(),
    });

    const response = await request(app).post('/api/link-preview').set('Authorization', authHeader).send({ url: PAGE_URL });
    const body = response.body as LinkPreviewMetadata;

    expect(response.status).toBe(200);
    expect(calls()).toBe(0);
    expect(encryptedLength(body.title)).toBeLessThanOrEqual(LINK_PREVIEW_ENCRYPTED_LIMITS.title);
    expect(encryptedLength(body.description ?? '')).toBeLessThanOrEqual(LINK_PREVIEW_ENCRYPTED_LIMITS.description);
    expect(encryptedLength(body.siteName ?? '')).toBeLessThanOrEqual(LINK_PREVIEW_ENCRYPTED_LIMITS.siteName);
    expect(body.imageUrl).toBe(METADATA.imageUrl);
  });

  it('answers linkPreview.unavailable when the resolved page URL would not fit once encrypted', async () => {
    const { fetcher } = createCountingFetcher({ ...METADATA, url: `https://example.com/${'p'.repeat(4000)}` });
    const { app, authHeader } = await setupAuthedApp(fetcher);

    const response = await request(app).post('/api/link-preview').set('Authorization', authHeader).send({ url: PAGE_URL });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: 'linkPreview.unavailable' });
  });
});

describe('GET /api/link-preview/image', () => {
  it('rejects an expired session with auth.sessionInvalid', async () => {
    const { app } = await buildTestApp();

    const response = await request(app)
      .get('/api/link-preview/image')
      .set('Authorization', 'Bearer ghost:not-a-token')
      .query({ url: 'https://example.com/cover.jpg' });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ message: 'Sessão inválida ou expirada.', code: 'auth.sessionInvalid' });
  });

  it('rejects a query that is not a valid URL with linkPreview.invalidUrl', async () => {
    const { app, authHeader } = await setupAuthedApp();

    const response = await request(app).get('/api/link-preview/image').set('Authorization', authHeader).query({ url: 'nope' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'URL inválida.', code: 'linkPreview.invalidUrl' });
  });

  it('answers linkPreview.imageUnavailable when the image cannot be loaded', async () => {
    const { app, authHeader } = await setupAuthedApp();

    const response = await request(app)
      .get('/api/link-preview/image')
      .set('Authorization', authHeader)
      .query({ url: 'http://127.0.0.1/cover.jpg' });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({ message: 'Não foi possível carregar essa imagem.', code: 'linkPreview.imageUnavailable' });
  });
});

async function setupAuthedApp(linkPreviewFetcher?: LinkPreviewFetcher) {
  const built = await buildTestApp(linkPreviewFetcher ? { linkPreviewFetcher } : {});
  const { user, sessionToken } = await built.userService.registerAccount({
    nickname: 'LinkPreviewer',
    avatar: 0,
    password: 'correct-horse-battery-staple',
  });

  return { ...built, authHeader: `Bearer ${user.id}:${sessionToken}` };
}
