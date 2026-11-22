import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MAX_AVATAR_UPLOAD_BYTES } from '@/modules/avatars/index.js';
import { MAX_USER_STORAGE_BYTES } from '@/modules/messages/message.controller.js';
import { generateOpenApiDocument } from '@/docs/openapi-document.js';
import { StorageQuota } from '@/storage/storage-quota.js';
import { StorageUsageRepository } from '@/storage/storage-usage.repository.js';
import { createTestDb } from './support/create-test-db.js';
import { buildTestApp } from './support/build-test-app.js';
import { TEST_V2_SIGNUP } from './support/test-constants.js';

const ENCRYPTED_BYTES = Buffer.alloc(2048, 7);
const AVATAR_URL_PATTERN = /^https:\/\/fake-object-storage\.test\/uploads\/avatars\/[0-9a-f-]{36}\.bin\?e2e=1$/;

async function signedUp(built: Awaited<ReturnType<typeof buildTestApp>>, nickname = 'Ada') {
  const { user, sessionToken } = await built.userService.registerAccount({ nickname, avatar: 0, password: 'correct-horse-battery-staple-0123456789abcd', ...TEST_V2_SIGNUP });
  return { user, authorization: `Bearer ${user.id}:${sessionToken}` };
}

function upload(built: Awaited<ReturnType<typeof buildTestApp>>, authorization: string) {
  return request(built.app).post('/api/avatars/upload').set('Authorization', authorization);
}

describe('POST /api/avatars/upload', () => {
  it('stores a neutral encrypted upload under uploads/avatars, unclaimed and counted in both quotas', async () => {
    const built = await buildTestApp();
    const { user, authorization } = await signedUp(built);

    const response = await upload(built, authorization)
      .field('encrypted', '1')
      .attach('image', ENCRYPTED_BYTES, { filename: 'blob.bin', contentType: 'application/octet-stream' });

    expect(response.status).toBe(201);
    const body = response.body as { url: string };
    expect(Object.keys(body)).toEqual(['url']);
    expect(body.url).toMatch(AVATAR_URL_PATTERN);
    const key = new URL(body.url).pathname.slice(1);
    await expect(built.uploadRegistry.find(key)).resolves.toMatchObject({ uploaderId: user.id, size: ENCRYPTED_BYTES.length, messageId: null, avatarOwner: null });
    await expect(built.objectStorage.getObject(key)).resolves.toEqual(ENCRYPTED_BYTES);
    expect(await built.uploadRegistry.totalBytesFor(user.id)).toBe(ENCRYPTED_BYTES.length);
  });

  it('requires authentication', async () => {
    const built = await buildTestApp();

    const response = await request(built.app)
      .post('/api/avatars/upload')
      .field('encrypted', '1')
      .attach('image', ENCRYPTED_BYTES, { filename: 'blob.bin', contentType: 'application/octet-stream' });

    expect(response.status).toBe(401);
  });

  it('rejects a real image instead of encrypted bytes', async () => {
    const built = await buildTestApp();
    const { authorization } = await signedUp(built);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const response = await upload(built, authorization).field('encrypted', '1').attach('image', png, { filename: 'me.png', contentType: 'image/png' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'upload.invalidType', params: { kind: 'avatar' } });
  });

  it('rejects neutral bytes without the encrypted flag', async () => {
    const built = await buildTestApp();
    const { authorization } = await signedUp(built);

    const response = await upload(built, authorization).attach('image', ENCRYPTED_BYTES, { filename: 'blob.bin', contentType: 'application/octet-stream' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'upload.invalidType' });
  });

  it('rejects files larger than 512 KB', async () => {
    const built = await buildTestApp();
    const { user, authorization } = await signedUp(built);

    const response = await upload(built, authorization)
      .field('encrypted', '1')
      .attach('image', Buffer.alloc(MAX_AVATAR_UPLOAD_BYTES + 1, 1), { filename: 'blob.bin', contentType: 'application/octet-stream' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'upload.tooLarge', params: { kind: 'avatar', maxSize: '512KB' } });
    expect(await built.uploadRegistry.totalBytesFor(user.id)).toBe(0);
  });

  it('accepts exactly 512 KB', async () => {
    const built = await buildTestApp();
    const { authorization } = await signedUp(built);

    const response = await upload(built, authorization)
      .field('encrypted', '1')
      .attach('image', Buffer.alloc(MAX_AVATAR_UPLOAD_BYTES, 1), { filename: 'blob.bin', contentType: 'application/octet-stream' });

    expect(response.status).toBe(201);
  });

  it('refuses uploads beyond the per-user storage limit', async () => {
    const built = await buildTestApp();
    const { user, authorization } = await signedUp(built);
    await built.uploadRegistry.register('uploads/files/big.bin', user.id, MAX_USER_STORAGE_BYTES - 10);

    const response = await upload(built, authorization)
      .field('encrypted', '1')
      .attach('image', ENCRYPTED_BYTES, { filename: 'blob.bin', contentType: 'application/octet-stream' });

    expect(response.status).toBe(507);
    expect(response.body).toMatchObject({ code: 'upload.newAccountQuotaExceeded' });
  });

  it('refuses uploads when the server storage is full', async () => {
    const db = await createTestDb();
    const built = await buildTestApp({ storageQuota: new StorageQuota(new StorageUsageRepository(db), 100) });
    const { authorization } = await signedUp(built);

    const response = await upload(built, authorization)
      .field('encrypted', '1')
      .attach('image', ENCRYPTED_BYTES, { filename: 'blob.bin', contentType: 'application/octet-stream' });

    expect(response.status).toBe(507);
    expect(response.body).toMatchObject({ code: 'upload.quotaExceeded' });
  });

  it('is documented in the OpenAPI document', () => {
    const document = generateOpenApiDocument();

    expect(document.paths?.['/api/avatars/upload']?.post).toBeDefined();
  });
});
