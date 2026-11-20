import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './rate-limit.js';

function buildApp(perUser: boolean, userId?: string) {
  const app = express();
  app.set('trust proxy', true);
  app.use((req, _res, next) => {
    if (userId) req.authenticatedUser = { id: userId } as never;
    next();
  });
  app.use(createRateLimiter({ limit: 2, code: 'rateLimit.api', perUser }));
  app.get('/', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('createRateLimiter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds limiters without any express-rate-limit validation error', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createRateLimiter({ limit: 1, code: 'rateLimit.api' });
    createRateLimiter({ limit: 1, code: 'rateLimit.api', perUser: true });
    expect(errors).not.toHaveBeenCalled();
  });

  it('groups IPv6 addresses of the same /64 together for anonymous limiters', async () => {
    const app = buildApp(false);
    await request(app).get('/').set('X-Forwarded-For', '2001:db8:1:2::1').expect(200);
    await request(app).get('/').set('X-Forwarded-For', '2001:db8:1:2::2').expect(200);
    await request(app).get('/').set('X-Forwarded-For', '2001:db8:1:2::3').expect(429);
    await request(app).get('/').set('X-Forwarded-For', '2001:db8:1:3::1').expect(200);
  });

  it('limits per user across addresses when authenticated', async () => {
    const app = buildApp(true, 'user-1');
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.1').expect(200);
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.2').expect(200);
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.3').expect(429);
  });

  it('falls back to the IPv6 /64 for unauthenticated requests on per-user limiters', async () => {
    const app = buildApp(true);
    await request(app).get('/').set('X-Forwarded-For', '2001:db8:9:9::1').expect(200);
    await request(app).get('/').set('X-Forwarded-For', '2001:db8:9:9::ffff').expect(200);
    await request(app).get('/').set('X-Forwarded-For', '2001:db8:9:9::abcd').expect(429);
  });
});
