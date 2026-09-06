import { describe, expect, it } from 'vitest';
import { StorageQuota, StorageQuotaExceededError } from '@/storage/storage-quota.js';
import { StorageUsageRepository } from '@/storage/storage-usage.repository.js';
import { createTestDb } from './support/create-test-db.js';

describe('StorageUsageRepository', () => {
  it('starts at zero bytes used', async () => {
    const db = await createTestDb();
    const repository = new StorageUsageRepository(db);

    expect(await repository.getBytesUsed()).toBe(0);
  });

  it('accumulates bytes across multiple additions', async () => {
    const db = await createTestDb();
    const repository = new StorageUsageRepository(db);

    await repository.addBytes(100);
    await repository.addBytes(250);

    expect(await repository.getBytesUsed()).toBe(350);
  });
});

describe('StorageQuota', () => {
  it('allows an upload that fits within the configured ceiling', async () => {
    const db = await createTestDb();
    const quota = new StorageQuota(new StorageUsageRepository(db), 1000);

    await expect(quota.ensureCapacity(500)).resolves.toBeUndefined();
  });

  it('rejects an upload that would exceed the configured ceiling', async () => {
    const db = await createTestDb();
    const repository = new StorageUsageRepository(db);
    await repository.addBytes(900);
    const quota = new StorageQuota(repository, 1000);

    await expect(quota.ensureCapacity(200)).rejects.toBeInstanceOf(StorageQuotaExceededError);
  });

  it('allows an upload that lands exactly on the ceiling', async () => {
    const db = await createTestDb();
    const repository = new StorageUsageRepository(db);
    await repository.addBytes(800);
    const quota = new StorageQuota(repository, 1000);

    await expect(quota.ensureCapacity(200)).resolves.toBeUndefined();
  });

  it('recordUsage increases the tracked total used by future checks', async () => {
    const db = await createTestDb();
    const repository = new StorageUsageRepository(db);
    const quota = new StorageQuota(repository, 1000);

    await quota.recordUsage(950);

    await expect(quota.ensureCapacity(100)).rejects.toBeInstanceOf(StorageQuotaExceededError);
  });
});
