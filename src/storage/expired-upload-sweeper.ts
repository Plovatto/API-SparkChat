import { logger } from '../config/logger.js';
import type { ObjectStorage } from './object-storage.js';
import type { StorageQuota } from './storage-quota.js';
import type { UploadRecord, UploadRegistry } from './upload-registry.js';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export const EXPIRED_UPLOAD_SWEEP_LIMITS = { batchSize: 100, maxBatches: 20 };

export interface ExpiredUploadSweepLimits {
  batchSize?: number;
  maxBatches?: number;
}

export class ExpiredUploadSweeper {
  constructor(
    private readonly registry: UploadRegistry,
    private readonly objectStorage: ObjectStorage,
    private readonly storageQuota: StorageQuota,
    private readonly now: () => number = Date.now,
    private readonly limits: ExpiredUploadSweepLimits = {},
  ) {}

  async sweep(): Promise<number> {
    const batchSize = this.limits.batchSize ?? EXPIRED_UPLOAD_SWEEP_LIMITS.batchSize;
    const maxBatches = this.limits.maxBatches ?? EXPIRED_UPLOAD_SWEEP_LIMITS.maxBatches;
    const cutoff = new Date(this.now()).toISOString();
    let removed = 0;

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const expired = await this.registry.findExpiredBefore(cutoff, batchSize);
      removed += await this.removeBatch(expired, cutoff);
      if (expired.length < batchSize) {
        break;
      }
    }

    return removed;
  }

  private async removeBatch(expired: UploadRecord[], cutoff: string): Promise<number> {
    let removed = 0;

    for (const upload of expired) {
      try {
        if (!(await this.registry.removeIfExpired(upload.key, cutoff))) {
          continue;
        }
        await this.objectStorage.deleteObject(upload.key);
        await this.storageQuota.releaseUsage(upload.size);
        removed += 1;
      } catch (err) {
        logger.error({ err, key: upload.key }, 'Failed to remove an expired upload');
      }
    }

    return removed;
  }

  start(): () => void {
    const timer = setInterval(() => {
      this.sweep().catch((err: unknown) => {
        logger.error({ err }, 'Expired upload sweep failed');
      });
    }, SWEEP_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
  }
}
