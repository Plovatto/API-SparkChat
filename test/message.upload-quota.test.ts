import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { StorageQuota } from '@/storage/storage-quota.js';
import { StorageUsageRepository } from '@/storage/storage-usage.repository.js';
import { buildTestApp } from './support/build-test-app.js';
import { createTestDb } from './support/create-test-db.js';

describe('upload endpoints under a storage quota ceiling', () => {
  it('rejects an upload once it would push total usage past the configured ceiling', async () => {
    const db = await createTestDb();
    const storageQuota = new StorageQuota(new StorageUsageRepository(db), 4);
    const { app, userService } = await buildTestApp({ storageQuota });
    const { user, sessionToken } = await userService.registerAccount({
      nickname: 'QuotaTester',
      avatar: 0,
      password: 'correct-horse-battery-staple',
      socketId: 'socket-quota',
    });
    const authHeader = `Bearer ${user.id}:${sessionToken}`;

    const response = await request(app)
      .post('/api/messages/upload-image')
      .set('Authorization', authHeader)
      .attach('image', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        filename: 'photo.png',
        contentType: 'image/png',
      });

    expect(response.status).toBe(507);
  });

  it('still allows an upload that fits within the configured ceiling', async () => {
    const db = await createTestDb();
    const storageQuota = new StorageQuota(new StorageUsageRepository(db), 1024 * 1024);
    const { app, userService } = await buildTestApp({ storageQuota });
    const { user, sessionToken } = await userService.registerAccount({
      nickname: 'QuotaTester2',
      avatar: 0,
      password: 'correct-horse-battery-staple',
      socketId: 'socket-quota-2',
    });
    const authHeader = `Bearer ${user.id}:${sessionToken}`;

    const response = await request(app)
      .post('/api/messages/upload-image')
      .set('Authorization', authHeader)
      .attach('image', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        filename: 'photo.png',
        contentType: 'image/png',
      });

    expect(response.status).toBe(201);
  });
});
