import { logger } from '../config/logger.js';
import type { ObjectStorage } from './object-storage.js';
import type { StorageQuota } from './storage-quota.js';
import type { UploadRegistry } from './upload-registry.js';

export const ORPHAN_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const SWEEP_BATCH_SIZE = 100;

export class OrphanUploadSweeper {
  constructor(
    private readonly registry: UploadRegistry,
    private readonly objectStorage: ObjectStorage,
    private readonly storageQuota: StorageQuota,
    private readonly now: () => number = Date.now,
  ) {}

  async sweep(): Promise<number> {
    const cutoff = new Date(this.now() - ORPHAN_UPLOAD_MAX_AGE_MS).toISOString();
    const orphans = await this.registry.findUnattachedBefore(cutoff, SWEEP_BATCH_SIZE);
    let removed = 0;

    for (const orphan of orphans) {
      try {
        if (!(await this.registry.removeIfUnattached(orphan.key))) {
          continue;
        }
        await this.objectStorage.deleteObject(orphan.key);
        await this.storageQuota.releaseUsage(orphan.size);
        removed += 1;
      } catch (err) {
        logger.error({ err, key: orphan.key }, 'Failed to remove an orphan upload');
      }
    }

    return removed + (await this.sweepUnreferencedAvatars());
  }

  private async sweepUnreferencedAvatars(): Promise<number> {
    const stale = await this.registry.findUnreferencedAvatars(SWEEP_BATCH_SIZE);
    let removed = 0;

    for (const avatar of stale) {
      try {
        const size = await this.registry.removeUnreferencedAvatar(avatar.key);
        if (size === null) {
          continue;
        }
        await this.objectStorage.deleteObject(avatar.key);
        await this.storageQuota.releaseUsage(size);
        removed += 1;
      } catch (err) {
        logger.error({ err, key: avatar.key }, 'Failed to remove an unreferenced avatar upload');
      }
    }

    return removed;
  }

  start(): () => void {
    const timer = setInterval(() => {
      this.sweep().catch((err: unknown) => {
        logger.error({ err }, 'Orphan upload sweep failed');
      });
    }, SWEEP_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
  }
}
