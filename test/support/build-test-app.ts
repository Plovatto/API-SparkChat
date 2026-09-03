import { createApp } from '@/app.js';
import { LoginRateLimiter, UserRepository, UserService, UserSessionRepository } from '@/modules/users/index.js';
import { createTestDb } from './create-test-db.js';
import { TEST_RECOVERY_FILE_SECRET } from './test-constants.js';

export async function buildTestApp() {
  const db = await createTestDb();
  const userRepository = new UserRepository(db);
  const userSessionRepository = new UserSessionRepository(db);
  const userService = new UserService(userRepository, userSessionRepository, TEST_RECOVERY_FILE_SECRET);
  const loginRateLimiter = new LoginRateLimiter();
  const app = createApp({ userService, loginRateLimiter });

  return { app, userService, userRepository, userSessionRepository, loginRateLimiter };
}
