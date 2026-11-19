import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MAX_USER_STORAGE_BYTES } from '@/modules/messages/message.controller.js';
import { GIF_UPLOAD_SIZES, GIF_UPLOAD_TTL_MS, MAX_LIVE_GIF_BYTES } from '@/modules/messages/message.upload.js';
import { StorageQuota } from '@/storage/storage-quota.js';
import { StorageUsageRepository } from '@/storage/storage-usage.repository.js';
import { buildTestApp } from './support/build-test-app.js';
import { createTestDb } from './support/create-test-db.js';
import { TEST_V2_SIGNUP } from './support/test-constants.js';

const KIB = 1024;
const SMALLEST = 256 * KIB + 40;

async function setup(options: Parameters<typeof buildTestApp>[0] = {}) {
  const built = await buildTestApp(options);
  const { user, sessionToken } = await built.userService.registerAccount({
    nickname: 'GifSender',
    avatar: 0,
    password: 'correct-horse-battery-staple-0123456789abcd',
    ...TEST_V2_SIGNUP,
  });
  return { ...built, user, authHeader: `Bearer ${user.id}:${sessionToken}` };
}

function uploadGif(
  app: Parameters<typeof request>[0],
  authHeader: string,
  size: number,
  { encrypted = true, filename = 'blob.bin', contentType = 'application/octet-stream' } = {},
) {
  const req = request(app).post('/api/messages/upload/gif').set('Authorization', authHeader);
  if (encrypted) {
    void req.field('encrypted', '1');
  }
  return req.attach('gif', Buffer.alloc(size, 7), { filename, contentType });
}

function keyOf(url: string): string {
  return new URL(url).pathname.slice(1);
}

describe('POST /api/messages/upload/gif', () => {
  it('only allows the padded step sizes plus the encryption overhead', () => {
    expect(GIF_UPLOAD_SIZES).toEqual([256 * KIB + 40, 512 * KIB + 40, 1024 * KIB + 40, 2048 * KIB + 40]);
  });

  it.each(GIF_UPLOAD_SIZES.map((size) => [size]))('stores an encrypted upload of %i bytes under uploads/gifs', async (size) => {
    const { app, authHeader, objectStorage, uploadRegistry, user } = await setup();

    const response = await uploadGif(app, authHeader, size);

    expect(response.status).toBe(201);
    const { url } = response.body as { url: string };
    expect(Object.keys(response.body as object)).toEqual(['url']);
    expect(url).toMatch(/^https:\/\/fake-object-storage\.test\/uploads\/gifs\/[0-9a-f-]{36}\.bin\?e2e=1$/);
    expect(await objectStorage.getObject(keyOf(url))).toHaveLength(size);
    await expect(uploadRegistry.find(keyOf(url))).resolves.toMatchObject({ uploaderId: user.id, size, messageId: null });
  });

  it('records an expiry thirty days ahead', async () => {
    const { app, authHeader, uploadRegistry } = await setup();
    const before = Date.now();

    const response = await uploadGif(app, authHeader, SMALLEST);

    const record = await uploadRegistry.find(keyOf((response.body as { url: string }).url));
    const expiresAt = Date.parse(record?.expiresAt ?? '');
    expect(expiresAt).toBeGreaterThanOrEqual(before + GIF_UPLOAD_TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + GIF_UPLOAD_TTL_MS);
    expect(GIF_UPLOAD_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it.each([
    ['one byte too few', SMALLEST - 1],
    ['one byte too many', SMALLEST + 1],
    ['the unpadded step', 256 * KIB],
    ['a tiny file', 10],
    ['between steps', 300 * KIB],
    ['above the largest step', 2048 * KIB + 41],
    ['far above the largest step', 3 * 1024 * KIB],
  ])('rejects %s', async (_label, size) => {
    const { app, authHeader, uploadRegistry } = await setup();

    const response = await uploadGif(app, authHeader, size);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'Tamanho de GIF inválido. Atualize o aplicativo e tente novamente.', code: 'upload.invalidGifSize' });
    await expect(uploadRegistry.findExpiredBefore(new Date(Date.now() + 2 * GIF_UPLOAD_TTL_MS).toISOString(), 10)).resolves.toEqual([]);
  });

  it('rejects an upload without the encrypted marker', async () => {
    const { app, authHeader } = await setup();

    const response = await uploadGif(app, authHeader, SMALLEST, { encrypted: false });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'upload.invalidType', params: { kind: 'gif' } });
  });

  it.each([
    ['a plain gif', 'cat.gif', 'image/gif'],
    ['a plain webp', 'cat.webp', 'image/webp'],
    ['a bin with another type', 'blob.bin', 'image/gif'],
    ['an octet stream with another extension', 'blob.dat', 'application/octet-stream'],
  ])('rejects %s', async (_label, filename, contentType) => {
    const { app, authHeader } = await setup();

    const response = await uploadGif(app, authHeader, SMALLEST, { filename, contentType });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'upload.invalidType', params: { kind: 'gif' } });
  });

  it('rejects a request without a file', async () => {
    const { app, authHeader } = await setup();

    const response = await request(app).post('/api/messages/upload/gif').set('Authorization', authHeader).field('encrypted', '1');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'Nenhum GIF enviado.', code: 'upload.missingFile', params: { kind: 'gif' } });
  });

  it('requires a session', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).post('/api/messages/upload/gif');

    expect(response.status).toBe(401);
  });

  it('is accepted even when the sender has used up the personal storage limit', async () => {
    const { app, authHeader, uploadRegistry, user } = await setup();
    await uploadRegistry.register('uploads/files/big.bin', user.id, MAX_USER_STORAGE_BYTES);

    const response = await uploadGif(app, authHeader, SMALLEST);

    expect(response.status).toBe(201);
  });

  it('does not count toward the personal storage limit', async () => {
    const { app, authHeader, uploadRegistry, user } = await setup();

    await uploadGif(app, authHeader, SMALLEST);
    await uploadGif(app, authHeader, 512 * KIB + 40);

    await expect(uploadRegistry.totalBytesFor(user.id)).resolves.toBe(0);
    await uploadRegistry.register('uploads/files/doc.bin', user.id, 99);
    await expect(uploadRegistry.totalBytesFor(user.id)).resolves.toBe(99);
  });

  it('counts toward the server-wide storage quota', async () => {
    const db = await createTestDb();
    const storageUsageRepository = new StorageUsageRepository(db);
    const { app, authHeader } = await setup({ storageQuota: new StorageQuota(storageUsageRepository, SMALLEST) });

    expect((await uploadGif(app, authHeader, SMALLEST)).status).toBe(201);
    expect(await storageUsageRepository.getBytesUsed()).toBe(SMALLEST);

    const full = await uploadGif(app, authHeader, SMALLEST);
    expect(full.status).toBe(507);
    expect(full.body).toMatchObject({ code: 'upload.quotaExceeded' });
  });

  it('limits each user to 30 gif uploads a minute', async () => {
    const { app, authHeader } = await setup();
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 31; attempt += 1) {
      statuses.push((await uploadGif(app, authHeader, 10)).status);
    }

    expect(statuses.slice(0, 30).every((status) => status === 400)).toBe(true);
    expect(statuses[30]).toBe(429);
    const limited = await uploadGif(app, authHeader, 10);
    expect(limited.body).toEqual({ message: 'Muitos GIFs enviados em pouco tempo. Aguarde e tente novamente.', code: 'rateLimit.gifUpload' });
  }, 30000);
});

describe('live gif bytes per user', () => {
  it('caps the bytes of a user’s unexpired gifs at 200 MiB', async () => {
    const { app, authHeader, uploadRegistry, user } = await setup();
    const future = new Date(Date.now() + GIF_UPLOAD_TTL_MS).toISOString();
    await uploadRegistry.register('uploads/gifs/old-1.bin', user.id, MAX_LIVE_GIF_BYTES - SMALLEST, { expiresAt: future });

    expect((await uploadGif(app, authHeader, SMALLEST)).status).toBe(201);
    await expect(uploadRegistry.expiringBytesFor(user.id)).resolves.toBe(MAX_LIVE_GIF_BYTES);

    const refused = await uploadGif(app, authHeader, SMALLEST);
    expect(refused.status).toBe(507);
    expect(refused.body).toEqual({
      message: 'Você atingiu o seu limite de armazenamento. Apague arquivos antigos para enviar novos.',
      code: 'upload.userQuotaExceeded',
    });
  });

  it('only sums uploads that expire, per uploader', async () => {
    const { uploadRegistry, user } = await setup();
    const future = new Date(Date.now() + GIF_UPLOAD_TTL_MS).toISOString();
    await uploadRegistry.register('uploads/gifs/a.bin', user.id, 10, { expiresAt: future });
    await uploadRegistry.register('uploads/files/b.bin', user.id, 1000);
    await uploadRegistry.register('uploads/gifs/c.bin', 'someone-else', 5, { expiresAt: future });

    await expect(uploadRegistry.expiringBytesFor(user.id)).resolves.toBe(10);
  });

  it('sets the cap to 200 MiB', () => {
    expect(MAX_LIVE_GIF_BYTES).toBe(200 * 1024 * 1024);
  });
});
