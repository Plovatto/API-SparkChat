import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { dataFilePath } from './config/paths.js';
import { JsonFileStore } from './database/json-file-store.js';
import { UserRepository } from './database/user.repository.js';
import type { UserRecord } from './models/user.model.js';
import { UserService } from './services/user.service.js';
import { registerSocketHandlers } from './sockets/index.js';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from './sockets/events.js';

const userStore = new JsonFileStore<UserRecord>(dataFilePath('users'));
await userStore.ensureFile();
const userRepository = new UserRepository(userStore);
const userService = new UserService(userRepository);
await userService.migrateLegacyCodes();

const app = createApp({ userService });
const httpServer = createServer(app);

const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>(httpServer, {
  cors: {
    origin: [env.FRONTEND_URL],
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

registerSocketHandlers(io, { userService });

httpServer.listen(env.PORT, () => {
  logger.info(`Server running on port ${env.PORT}`);
  logger.info(`Frontend URL: ${env.FRONTEND_URL}`);
  logger.info(`Environment: ${env.NODE_ENV}`);
  logger.info(`API docs: http://localhost:${env.PORT}/docs`);
});

httpServer.on('error', (err) => {
  logger.error({ err }, 'Server failed to start');
  process.exit(1);
});
