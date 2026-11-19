import { logger } from '../config/logger.js';
import type { ObjectStorage } from './object-storage.js';
import type { StorageQuota } from './storage-quota.js';
import type { UploadRegistry } from './upload-registry.js';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const SWEEP_BATCH_SIZE = 100;

export class ExpiredUploadSweeper {
  constructor(
    private readonly registry: UploadRegistry,
    private readonly objectStorage: ObjectStorage,
    private readonly storageQuota: StorageQuota,
    private readonly now: () => number = Date.now,
  ) {}

  async sweep(): Promise<number> {
    const cutoff = new Date(this.now()).toISOString();
    const expired = await this.registry.findExpiredBefore(cutoff, SWEEP_BATCH_SIZE);
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
