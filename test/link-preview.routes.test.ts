import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { LinkPreviewFetcher, LinkPreviewMetadata } from '@/modules/link-preview/index.js';
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
  });

  it('rejects a body that is not a valid URL', async () => {
    const { app, authHeader } = await setupAuthedApp();

    const response = await request(app).post('/api/link-preview').set('Authorization', authHeader).send({ url: 'not-a-url' });

    expect(response.status).toBe(400);
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
  });

  it('serves a second request from cache without calling the fetcher again', async () => {
    const { fetcher, calls } = createCountingFetcher(METADATA);
    const { app, authHeader } = await setupAuthedApp(fetcher);

    await request(app).post('/api/link-preview').set('Authorization', authHeader).send({ url: PAGE_URL });
    const second = await request(app).post('/api/link-preview').set('Authorization', authHeader).send({ url: PAGE_URL });

    expect(second.status).toBe(200);
    expect(calls()).toBe(1);
  });
});

async function setupAuthedApp(linkPreviewFetcher?: LinkPreviewFetcher) {
  const built = await buildTestApp(linkPreviewFetcher ? { linkPreviewFetcher } : {});
  const { user, sessionToken } = await built.userService.registerAccount({
    nickname: 'LinkPreviewer',
    avatar: 0,
    password: 'correct-horse-battery-staple',
    socketId: 'socket-link-preview',
  });

  return { ...built, authHeader: `Bearer ${user.id}:${sessionToken}` };
}
