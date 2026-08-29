import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { dataFilePath } from './config/paths.js';
import { JsonFileStore } from './database/json-file-store.js';
import { MessageRepository, MessageService, TypingService, type MessageRecord } from './modules/messages/index.js';
import { RoomRepository, RoomService, type RoomRecord } from './modules/rooms/index.js';
import { UserRepository, UserService, type UserRecord } from './modules/users/index.js';
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

const messageStore = new JsonFileStore<MessageRecord>(dataFilePath('messages'));
await messageStore.ensureFile();
const messageRepository = new MessageRepository(messageStore);
const messageService = new MessageService(messageRepository, userService);

const roomStore = new JsonFileStore<RoomRecord>(dataFilePath('rooms'));
await roomStore.ensureFile();
const roomRepository = new RoomRepository(roomStore);
const roomService = new RoomService(roomRepository, userService, messageService);

const typingService = new TypingService();

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

registerSocketHandlers(io, { userService, roomService, messageService, typingService });

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
