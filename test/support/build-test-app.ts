import { createApp } from '@/app.js';
import { UserRepository, UserService } from '@/modules/users/index.js';
import { createTestDb } from './create-test-db.js';

export async function buildTestApp() {
  const db = await createTestDb();
  const userRepository = new UserRepository(db);
  const userService = new UserService(userRepository);
  const app = createApp({ userService });

  return { app, userService, userRepository };
}
