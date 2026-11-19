import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { FakeGifProvider, GifProviderError, type GifPage, type GifProvider } from '@/modules/gifs/index.js';
import { buildTestApp } from './support/build-test-app.js';
import { TEST_V2_SIGNUP } from './support/test-constants.js';

const MEDIA_URL = 'https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/eUbp2uNc.webp';
const WEBP = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 '), Buffer.alloc(32, 1)]);
const EMPTY_PAGE: GifPage = { items: [], page: 1, hasNext: false };

function stubProvider(overrides: Partial<GifProvider> = {}) {
  return {
    trending: vi.fn<GifProvider['trending']>(overrides.trending ?? (() => Promise.resolve(EMPTY_PAGE))),
    search: vi.fn<GifProvider['search']>(overrides.search ?? (() => Promise.resolve(EMPTY_PAGE))),
    fetchMedia: vi.fn<GifProvider['fetchMedia']>(overrides.fetchMedia ?? (() => Promise.resolve({ contentType: 'image/webp', body: WEBP }))),
  };
}

async function setup(gifProvider: GifProvider | null) {
  const built = await buildTestApp({ gifProvider });
  const { user, sessionToken } = await built.userService.registerAccount({
    nickname: 'GifFan',
    avatar: 0,
    password: 'correct-horse-battery-staple-0123456789abcd',
    ...TEST_V2_SIGNUP,
  });
  return { ...built, user, authHeader: `Bearer ${user.id}:${sessionToken}` };
}

describe('gif routes authentication', () => {
  it.each([
    ['get', '/api/gifs/status'],
    ['post', '/api/gifs/trending'],
    ['post', '/api/gifs/search'],
    ['post', '/api/gifs/media'],
  ] as const)('requires a session for %s %s', async (method, path) => {
    const { app } = await buildTestApp({ gifProvider: stubProvider() });

    const response = await request(app)[method](path).send({});

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'auth.required' });
  });
});

describe('gif routes when the gallery is off', () => {
  it('reports the gallery as disabled', async () => {
    const { app, authHeader } = await setup(null);

    const response = await request(app).get('/api/gifs/status').set('Authorization', authHeader);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ enabled: false });
  });

  it.each(['/api/gifs/trending', '/api/gifs/search', '/api/gifs/media'])('answers %s with 503', async (path) => {
    const { app, authHeader } = await setup(null);

    const response = await request(app).post(path).set('Authorization', authHeader).send({ q: 'cat', url: MEDIA_URL });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ message: 'A galeria de GIFs não está disponível no momento.', code: 'gifs.unavailable' });
  });
});

describe('gif listing routes', () => {
  it('reports the gallery as enabled', async () => {
    const { app, authHeader } = await setup(stubProvider());

    const response = await request(app).get('/api/gifs/status').set('Authorization', authHeader);

    expect(response.body).toEqual({ enabled: true });
  });

  it('returns trending GIFs with the requested page and locale', async () => {
    const provider = stubProvider();
    const { app, authHeader } = await setup(provider);

    const response = await request(app).post('/api/gifs/trending').set('Authorization', authHeader).send({ page: 3, locale: 'us' });

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual(EMPTY_PAGE);
    expect(provider.trending).toHaveBeenCalledWith(3, 'us');
  });

  it('defaults trending to the first page without a locale', async () => {
    const provider = stubProvider();
    const { app, authHeader } = await setup(provider);

    await request(app).post('/api/gifs/trending').set('Authorization', authHeader).send({});

    expect(provider.trending).toHaveBeenCalledWith(1, undefined);
  });

  it('trims the search term before asking the provider', async () => {
    const provider = stubProvider();
    const { app, authHeader } = await setup(provider);

    const response = await request(app).post('/api/gifs/search').set('Authorization', authHeader).send({ q: '  gato  ', locale: 'br' });

    expect(response.status).toBe(200);
    expect(provider.search).toHaveBeenCalledWith('gato', 1, 'br');
  });

  it('serves the fake provider end to end', async () => {
    const { app, authHeader } = await setup(new FakeGifProvider({ pageSize: 3 }));

    const response = await request(app).post('/api/gifs/search').set('Authorization', authHeader).send({ q: 'cat' });

    expect(response.status).toBe(200);
    expect((response.body as GifPage).items).toHaveLength(3);
    expect((response.body as GifPage).hasNext).toBe(true);
  });

  it.each([
    ['an empty term', { q: '   ' }],
    ['a missing term', {}],
    ['a term over 100 characters', { q: 'a'.repeat(101) }],
    ['a non-string term', { q: 42 }],
    ['page zero', { q: 'cat', page: 0 }],
    ['page 51', { q: 'cat', page: 51 }],
    ['a fractional page', { q: 'cat', page: 1.5 }],
    ['an unknown locale', { q: 'cat', locale: 'fr' }],
    ['an unexpected field', { q: 'cat', customer_id: 'x' }],
  ])('rejects a search with %s', async (_label, body) => {
    const provider = stubProvider();
    const { app, authHeader } = await setup(provider);

    const response = await request(app).post('/api/gifs/search').set('Authorization', authHeader).send(body);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'Busca de GIF inválida.', code: 'gifs.invalidQuery' });
    expect(provider.search).not.toHaveBeenCalled();
  });

  it('rejects an invalid trending page', async () => {
    const { app, authHeader } = await setup(stubProvider());

    const response = await request(app).post('/api/gifs/trending').set('Authorization', authHeader).send({ page: 'x' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'gifs.invalidQuery' });
  });

  it('answers 502 when the provider fails', async () => {
    const provider = stubProvider({ search: () => Promise.reject(new GifProviderError()) });
    const { app, authHeader } = await setup(provider);

    const response = await request(app).post('/api/gifs/search').set('Authorization', authHeader).send({ q: 'cat' });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ message: 'Não foi possível carregar os GIFs agora. Tente novamente.', code: 'gifs.providerFailed' });
  });

  it('limits listing to 60 requests a minute per user', async () => {
    const { app, authHeader, userService } = await setup(stubProvider());
    const registerOther = async () => {
      const { user, sessionToken } = await userService.registerAccount({
        nickname: 'OtherFan',
        avatar: 0,
        password: 'correct-horse-battery-staple-0123456789abcd',
        ...TEST_V2_SIGNUP,
      });
      return `Bearer ${user.id}:${sessionToken}`;
    };
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 61; attempt += 1) {
      const response =
        attempt % 2 === 0
          ? await request(app).post('/api/gifs/trending').set('Authorization', authHeader).send({})
          : await request(app).post('/api/gifs/search').set('Authorization', authHeader).send({ q: 'cat' });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    const limited = await request(app).post('/api/gifs/trending').set('Authorization', authHeader).send({});
    expect(limited.body).toEqual({
      message: 'Muitas buscas de GIF em pouco tempo. Aguarde um momento e tente novamente.',
      code: 'rateLimit.gifs',
    });

    const other = await registerOther();
    const otherResponse = await request(app).post('/api/gifs/trending').set('Authorization', other).send({});
    expect(otherResponse.status).toBe(200);
  }, 30000);
});

describe('gif media route', () => {
  it('returns the media bytes with safe headers', async () => {
    const provider = stubProvider();
    const { app, authHeader } = await setup(provider);

    const response = await request(app).post('/api/gifs/media').set('Authorization', authHeader).send({ url: MEDIA_URL });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('private, max-age=3600');
    expect(Buffer.from(response.body as Buffer)).toEqual(WEBP);
    expect(provider.fetchMedia).toHaveBeenCalledWith(MEDIA_URL);
  });

  it.each([
    ['another host', { url: 'https://example.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/eUbp2uNc.webp' }],
    ['a query string', { url: `${MEDIA_URL}?a=1` }],
    ['a missing url', {}],
    ['a non-string url', { url: 1 }],
  ])('rejects %s without calling the provider', async (_label, body) => {
    const provider = stubProvider();
    const { app, authHeader } = await setup(provider);

    const response = await request(app).post('/api/gifs/media').set('Authorization', authHeader).send(body);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'Endereço de GIF inválido.', code: 'gifs.invalidMediaUrl' });
    expect(provider.fetchMedia).not.toHaveBeenCalled();
  });

  it('answers 502 when the media cannot be fetched', async () => {
    const { app, authHeader } = await setup(stubProvider({ fetchMedia: () => Promise.reject(new GifProviderError()) }));

    const response = await request(app).post('/api/gifs/media').set('Authorization', authHeader).send({ url: MEDIA_URL });

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({ code: 'gifs.providerFailed' });
  });

  it('serves fake media end to end', async () => {
    const provider = new FakeGifProvider({ pageSize: 1 });
    const [item] = (await provider.trending(1)).items;
    const { app, authHeader } = await setup(provider);

    const response = await request(app).post('/api/gifs/media').set('Authorization', authHeader).send({ url: item?.url });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    expect((response.body as Buffer).length).toBe(item?.size);
  });
});

describe('gif routes documentation', () => {
  it('lists every gif route and the gif upload in the OpenAPI document', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).get('/docs/openapi.json');

    const paths = (response.body as { paths: Record<string, Record<string, unknown>> }).paths;
    expect(paths['/api/gifs/status']).toHaveProperty('get');
    expect(paths['/api/gifs/trending']).toHaveProperty('post');
    expect(paths['/api/gifs/search']).toHaveProperty('post');
    expect(paths['/api/gifs/media']).toHaveProperty('post');
    expect(paths['/api/messages/upload/gif']).toHaveProperty('post');
  });
});
