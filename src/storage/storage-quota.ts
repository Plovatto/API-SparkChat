import type { StorageUsageRepository } from './storage-usage.repository.js';

export const DEFAULT_MAX_STORAGE_BYTES = 8 * 1024 * 1024 * 1024;

export const PER_USER_SHARE_OF_STORAGE = 0.05;

export class StorageQuotaExceededError extends Error {
  constructor() {
    super('Storage quota exceeded');
    this.name = 'StorageQuotaExceededError';
  }
}

export class StorageQuota {
  constructor(
    private readonly repository: StorageUsageRepository,
    private readonly maxBytes: number = DEFAULT_MAX_STORAGE_BYTES,
  ) {}

  async ensureCapacity(additionalBytes: number): Promise<void> {
    const used = await this.repository.getBytesUsed();
    if (used + additionalBytes > this.maxBytes) {
      throw new StorageQuotaExceededError();
    }
  }

  async reserve(bytes: number): Promise<void> {
    if (!(await this.repository.tryReserve(bytes, this.maxBytes))) {
      throw new StorageQuotaExceededError();
    }
  }

  userLimitBytes(configuredLimitBytes: number): number {
    return Math.min(configuredLimitBytes, Math.floor(this.maxBytes * PER_USER_SHARE_OF_STORAGE));
  }

  async recordUsage(bytes: number): Promise<void> {
    await this.repository.addBytes(bytes);
  }

  async releaseUsage(bytes: number): Promise<void> {
    await this.repository.addBytes(-bytes);
  }
}
