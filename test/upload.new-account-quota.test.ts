import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_USER_STORAGE_BYTES, NEW_ACCOUNT_STORAGE_BYTES, NEW_ACCOUNT_WINDOW_MS } from '@/modules/messages/message.controller.js';
import { buildTestApp } from './support/build-test-app.js';
import { TEST_V2_SIGNUP } from './support/test-constants.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PASSWORD = 'correct-horse-battery-staple-0123456789abcd';

afterEach(() => {
  vi.useRealTimers();
});

async function registerAt(createdAgoMs: number, nickname: string) {
  const built = await buildTestApp();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() - createdAgoMs);
  const { user } = await built.userService.registerAccount({ nickname, avatar: 0, password: PASSWORD, ...TEST_V2_SIGNUP });
  vi.useRealTimers();
  const login = await built.userService.login(nickname, PASSWORD);
  if (!login) {
    throw new Error('login failed');
  }
  return { ...built, user, authHeader: `Bearer ${user.id}:${login.sessionToken}` };
}

function uploadImage(app: Awaited<ReturnType<typeof buildTestApp>>['app'], authHeader: string) {
  return request(app).post('/api/messages/upload-image').set('Authorization', authHeader).attach('image', PNG_BYTES, { filename: 'photo.png', contentType: 'image/png' });
}

describe('storage quota for new accounts', () => {
  it('limits a freshly created account to the new-account allowance', async () => {
    const { app, uploadRegistry, user, authHeader } = await registerAt(0, 'Newcomer');
    await uploadRegistry.register('uploads/files/seed.bin', user.id, NEW_ACCOUNT_STORAGE_BYTES - 4);

    const response = await uploadImage(app, authHeader);

    expect(response.status).toBe(507);
    expect(response.body).toMatchObject({ code: 'upload.newAccountQuotaExceeded' });
  });

  it('lets an account past the probation window use the full per-user allowance', async () => {
    const { app, uploadRegistry, user, authHeader } = await registerAt(NEW_ACCOUNT_WINDOW_MS + 60_000, 'Veteran');
    await uploadRegistry.register('uploads/files/seed.bin', user.id, NEW_ACCOUNT_STORAGE_BYTES);

    expect((await uploadImage(app, authHeader)).status).toBe(201);

    await uploadRegistry.register('uploads/files/more.bin', user.id, MAX_USER_STORAGE_BYTES);
    const refused = await uploadImage(app, authHeader);
    expect(refused.status).toBe(507);
    expect(refused.body).toMatchObject({ code: 'upload.userQuotaExceeded' });
  });
});
