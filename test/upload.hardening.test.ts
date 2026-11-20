import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createUploadConcurrencyGuard, UploadConcurrencyLimiter } from '@/modules/messages/index.js';
import { InMemoryObjectStorage } from '@/storage/object-storage.js';
import { StorageQuota, StorageQuotaExceededError } from '@/storage/storage-quota.js';
import { StorageUsageRepository } from '@/storage/storage-usage.repository.js';
import { UploadRegistry } from '@/storage/upload-registry.js';
import { buildTestApp } from './support/build-test-app.js';
import { createTestDb } from './support/create-test-db.js';
import { TEST_V2_SIGNUP } from './support/test-constants.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function registerUser(userService: Awaited<ReturnType<typeof buildTestApp>>['userService'], nickname: string) {
  const { user, sessionToken } = await userService.registerAccount({
    nickname,
    avatar: 0,
    password: 'correct-horse-battery-staple-0123456789abcd',
    ...TEST_V2_SIGNUP,
  });
  return { user, auth: `Bearer ${user.id}:${sessionToken}` };
}

describe('atomic global storage reservation', () => {
  it('never accepts more reserved bytes than the ceiling under parallel reservations', async () => {
    const db = await createTestDb();
    const repository = new StorageUsageRepository(db);
    const quota = new StorageQuota(repository, 1000);

    const outcomes = await Promise.all(
      Array.from({ length: 40 }, () =>
        quota.reserve(100).then(
          () => true,
          (err: unknown) => {
            expect(err).toBeInstanceOf(StorageQuotaExceededError);
            return false;
          },
        ),
      ),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(10);
    expect(await repository.getBytesUsed()).toBe(1000);
  });

  it('frees a reservation when it is released', async () => {
    const db = await createTestDb();
    const quota = new StorageQuota(new StorageUsageRepository(db), 100);

    await quota.reserve(100);
    await expect(quota.reserve(1)).rejects.toBeInstanceOf(StorageQuotaExceededError);
    await quota.releaseUsage(100);

    await expect(quota.reserve(100)).resolves.toBeUndefined();
  });

  it('limits a single user to a share of the global ceiling', () => {
    const quota = new StorageQuota(new StorageUsageRepository({} as never), 1000);

    expect(quota.userLimitBytes(500)).toBe(50);
    expect(quota.userLimitBytes(10)).toBe(10);
  });
});

describe('atomic per-user upload reservation', () => {
  it('never lets parallel reservations exceed the per-user limit', async () => {
    const db = await createTestDb();
    const registry = new UploadRegistry(db);

    const outcomes = await Promise.all(
      Array.from({ length: 30 }, (_, index) => registry.reserve(`k${index}`, 'user-1', 100, { permanentLimitBytes: 1000 })),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(10);
    expect(await registry.totalBytesFor('user-1')).toBe(1000);
    expect(await registry.reserve('other', 'user-2', 100, { permanentLimitBytes: 1000 })).toBe(true);
  });

  it('applies the expiring limit separately from the permanent one', async () => {
    const db = await createTestDb();
    const registry = new UploadRegistry(db);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    expect(await registry.reserve('g1', 'u', 60, { expiresAt, expiringLimitBytes: 100 })).toBe(true);
    expect(await registry.reserve('g2', 'u', 60, { expiresAt, expiringLimitBytes: 100 })).toBe(false);
    expect(await registry.reserve('p1', 'u', 500, { permanentLimitBytes: 600 })).toBe(true);
  });
});

describe('upload endpoints', () => {
  it('stops one user from exceeding the per-user share with parallel uploads', async () => {
    const db = await createTestDb();
    const quota = new StorageQuota(new StorageUsageRepository(db), 20 * 1024);
    const { app, userService, uploadRegistry } = await buildTestApp({ storageQuota: quota });
    const { user, auth } = await registerUser(userService, 'Racer');
    const body = Buffer.concat([PNG, Buffer.alloc(400)]);

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app).post('/api/messages/upload-image').set('Authorization', auth).attach('image', body, { filename: 'a.png', contentType: 'image/png' }),
      ),
    );

    const accepted = responses.filter((response) => response.status === 201).length;
    const limit = quota.userLimitBytes(500 * 1024 * 1024);
    expect(accepted * body.length).toBeLessThanOrEqual(limit);
    expect(accepted).toBe(Math.floor(limit / body.length));
    expect(await uploadRegistry.totalBytesFor(user.id)).toBe(accepted * body.length);
    expect(responses.filter((response) => response.status === 507).every((response) => (response.body as { code: string }).code === 'upload.userQuotaExceeded')).toBe(true);
  });

  it('releases the reservation when storing the object fails', async () => {
    const failing = new InMemoryObjectStorage();
    failing.putObject = () => Promise.reject(new Error('r2 down'));
    const db = await createTestDb();
    const repository = new StorageUsageRepository(db);
    const { app, userService, uploadRegistry } = await buildTestApp({
      objectStorage: failing,
      storageQuota: new StorageQuota(repository, 1024 * 1024),
    });
    const { user, auth } = await registerUser(userService, 'Failer');

    const response = await request(app)
      .post('/api/messages/upload-image')
      .set('Authorization', auth)
      .attach('image', PNG, { filename: 'a.png', contentType: 'image/png' });

    expect(response.status).toBe(500);
    expect(await repository.getBytesUsed()).toBe(0);
    expect(await uploadRegistry.totalBytesFor(user.id)).toBe(0);
  });

  it('rejects bodies with more than one file', async () => {
    const { app, userService } = await buildTestApp();
    const { auth } = await registerUser(userService, 'Multi');

    const response = await request(app)
      .post('/api/messages/upload-image')
      .set('Authorization', auth)
      .attach('image', PNG, { filename: 'a.png', contentType: 'image/png' })
      .attach('image', PNG, { filename: 'b.png', contentType: 'image/png' });

    expect(response.status).toBe(400);
  });

  it('rejects bodies with extra form fields', async () => {
    const { app, userService } = await buildTestApp();
    const { auth } = await registerUser(userService, 'Fields');

    let call = request(app).post('/api/messages/upload-image').set('Authorization', auth);
    for (let index = 0; index < 5; index += 1) {
      call = call.field(`f${index}`, 'x');
    }
    const response = await call.attach('image', PNG, { filename: 'a.png', contentType: 'image/png' });

    expect(response.status).toBe(400);
  });

  it('rejects an oversized declared body before reading it', async () => {
    const { app, userService } = await buildTestApp();
    const { auth } = await registerUser(userService, 'Huge');

    const response = await request(app)
      .post('/api/messages/upload-image')
      .set('Authorization', auth)
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .set('Content-Length', String(6 * 1024 * 1024))
      .send('--x--');

    expect(response.status).toBe(400);
    expect((response.body as { code: string }).code).toBe('upload.tooLarge');
  });
});

describe('upload concurrency guard', () => {
  function buildApp(limiter: UploadConcurrencyLimiter, release: () => Promise<void>) {
    const app = express();
    app.use((req, _res, next) => {
      req.authenticatedUser = { id: String(req.headers['x-user']) } as never;
      next();
    });
    app.post('/up', createUploadConcurrencyGuard(limiter, 'file', '50MB', { maxBytesPerUpload: 1024 }), async (_req, res) => {
      await release();
      res.status(201).json({});
    });
    return app;
  }

  it('returns 429 for a user holding too many uploads open and frees the slot afterwards', async () => {
    const limiter = new UploadConcurrencyLimiter(2, 100, 1_000_000);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const app = buildApp(limiter, () => gate);

    const first = request(app).post('/up').set('x-user', 'u1').send('a').then((r) => r);
    const second = request(app).post('/up').set('x-user', 'u1').send('a').then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const third = await request(app).post('/up').set('x-user', 'u1').send('a');
    expect(third.status).toBe(429);
    expect((third.body as { code: string }).code).toBe('rateLimit.upload');
    const other = request(app).post('/up').set('x-user', 'u2').send('a').then((r) => r);

    open();
    expect((await first).status).toBe(201);
    expect((await second).status).toBe(201);
    expect((await other).status).toBe(201);
    expect(limiter.inFlight()).toBe(0);
    expect((await request(app).post('/up').set('x-user', 'u1').send('a')).status).toBe(201);
  });

  it('caps total in-flight uploads and bytes across users', () => {
    const limiter = new UploadConcurrencyLimiter(5, 3, 100);

    const a = limiter.tryAcquire('a', 40);
    const b = limiter.tryAcquire('b', 40);
    expect(limiter.tryAcquire('c', 40)).toBeNull();
    expect(limiter.tryAcquire('c', 20)).not.toBeNull();
    expect(limiter.tryAcquire('d', 1)).toBeNull();
    a?.();
    a?.();
    expect(limiter.tryAcquire('d', 30)).not.toBeNull();
    b?.();
  });
});
