import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { db } from './database/turso-client.js';
import { runMigrations } from './database/migrate.js';
import {
  MessageRepository,
  MessageService,
  RecordingService,
  RoomPresenceService,
  TypingService,
} from './modules/messages/index.js';
import { RoomRepository, RoomService } from './modules/rooms/index.js';
import { UserRepository, UserService } from './modules/users/index.js';
import { registerSocketHandlers } from './sockets/index.js';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from './sockets/events.js';

await runMigrations(db);

const userRepository = new UserRepository(db);
const userService = new UserService(userRepository);
await userService.migrateLegacyCodes();

const messageRepository = new MessageRepository(db);
const messageService = new MessageService(messageRepository, userService);

const roomRepository = new RoomRepository(db);
const roomService = new RoomService(roomRepository, userService, messageService);

const typingService = new TypingService();
const recordingService = new RecordingService();
const presenceService = new RoomPresenceService();

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

registerSocketHandlers(io, { userService, roomService, messageService, typingService, recordingService, presenceService });

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
