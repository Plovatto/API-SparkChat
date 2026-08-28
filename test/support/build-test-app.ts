import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '@/app.js';
import { JsonFileStore } from '@/database/json-file-store.js';
import { UserRepository } from '@/database/user.repository.js';
import type { UserRecord } from '@/models/user.model.js';
import { UserService } from '@/services/user.service.js';

export function buildTestApp() {
  const dataFile = path.join(os.tmpdir(), `sparkchat-test-users-${randomUUID()}.json`);
  const userStore = new JsonFileStore<UserRecord>(dataFile);
  const userRepository = new UserRepository(userStore);
  const userService = new UserService(userRepository);
  const app = createApp({ userService });

  return { app, userService, userRepository };
}
