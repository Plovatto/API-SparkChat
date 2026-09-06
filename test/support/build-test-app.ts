import { createApp } from '@/app.js';
import { LinkPreviewRepository, LinkPreviewService, type LinkPreviewFetcher } from '@/modules/link-preview/index.js';
import { LoginRateLimiter, UserRepository, UserService, UserSessionRepository } from '@/modules/users/index.js';
import { InMemoryObjectStorage, type ObjectStorage } from '@/storage/object-storage.js';
import { StorageQuota } from '@/storage/storage-quota.js';
import { StorageUsageRepository } from '@/storage/storage-usage.repository.js';
import { createTestDb } from './create-test-db.js';
import { TEST_RECOVERY_FILE_SECRET } from './test-constants.js';

const noopLinkPreviewFetcher: LinkPreviewFetcher = {
  fetchMetadata: () => Promise.resolve(null),
};

export async function buildTestApp(
  options: { linkPreviewFetcher?: LinkPreviewFetcher; objectStorage?: ObjectStorage; storageQuota?: StorageQuota } = {},
) {
  const db = await createTestDb();
  const userRepository = new UserRepository(db);
  const userSessionRepository = new UserSessionRepository(db);
  const userService = new UserService(userRepository, userSessionRepository, TEST_RECOVERY_FILE_SECRET);
  const loginRateLimiter = new LoginRateLimiter();
  const linkPreviewRepository = new LinkPreviewRepository(db);
  const linkPreviewService = new LinkPreviewService(linkPreviewRepository, options.linkPreviewFetcher ?? noopLinkPreviewFetcher);
  const objectStorage = options.objectStorage ?? new InMemoryObjectStorage();
  const storageUsageRepository = new StorageUsageRepository(db);
  const storageQuota = options.storageQuota ?? new StorageQuota(storageUsageRepository);
  const app = createApp({ userService, loginRateLimiter, linkPreviewService, objectStorage, storageQuota });

  return {
    app,
    userService,
    userRepository,
    userSessionRepository,
    loginRateLimiter,
    linkPreviewRepository,
    linkPreviewService,
    objectStorage,
    storageQuota,
  };
}
