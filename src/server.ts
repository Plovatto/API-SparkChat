import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { db } from './database/turso-client.js';
import { runMigrations } from './database/migrate.js';
import { AiService, AiUsageLimiter, createGeminiRouter, ensureAssistantUser, loadAssistantIdentity } from './modules/ai/index.js';
import { httpLinkPreviewFetcher, LinkPreviewRepository, LinkPreviewService } from './modules/link-preview/index.js';
import {
  MessageRateLimiter,
  MessageRepository,
  MessageService,
  RecordingService,
  RoomPresenceService,
  TypingService,
} from './modules/messages/index.js';
import { RoomKeyRepository, RoomRepository, RoomService } from './modules/rooms/index.js';
import { LoginRateLimiter, UserRepository, UserService, UserSessionRepository } from './modules/users/index.js';
import { registerSocketHandlers } from './sockets/index.js';
import { createR2ObjectStorage } from './storage/r2-object-storage.js';
import { StorageQuota } from './storage/storage-quota.js';
import { StorageUsageRepository } from './storage/storage-usage.repository.js';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from './sockets/events.js';

await runMigrations(db);

const userRepository = new UserRepository(db);
const userSessionRepository = new UserSessionRepository(db);
const userService = new UserService(userRepository, userSessionRepository, env.RECOVERY_FILE_SECRET);
const loginRateLimiter = new LoginRateLimiter();

const objectStorage = createR2ObjectStorage({
  accountId: env.R2_ACCOUNT_ID,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  bucketName: env.R2_BUCKET_NAME,
  publicBaseUrl: env.R2_PUBLIC_BASE_URL,
});
const storageUsageRepository = new StorageUsageRepository(db);
const storageQuota = new StorageQuota(storageUsageRepository);

const messageRepository = new MessageRepository(db);
const messageService = new MessageService(messageRepository, userService, objectStorage, storageQuota);

const roomRepository = new RoomRepository(db);
const roomService = new RoomService(roomRepository, userService, messageService);
const roomKeyRepository = new RoomKeyRepository(db);

const typingService = new TypingService();
const recordingService = new RecordingService();
const presenceService = new RoomPresenceService();
const messageRateLimiter = new MessageRateLimiter();

const linkPreviewRepository = new LinkPreviewRepository(db);
const linkPreviewService = new LinkPreviewService(linkPreviewRepository, httpLinkPreviewFetcher);

const assistantIdentity = await loadAssistantIdentity(env.AI_ASSISTANT_PRIVATE_KEY);
await ensureAssistantUser(userRepository, assistantIdentity);
const aiRouter = createGeminiRouter(env.GEMINI_API_KEY);
const aiUsageLimiter = new AiUsageLimiter();
const aiService = new AiService(
  assistantIdentity,
  roomKeyRepository,
  messageService,
  typingService,
  presenceService,
  aiRouter,
  aiUsageLimiter,
  objectStorage,
);

const app = createApp({ userService, loginRateLimiter, linkPreviewService, objectStorage, storageQuota });
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
  pingInterval: 20000,
  pingTimeout: 25000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 5 * 60 * 1000,
    skipMiddlewares: true,
  },
});

registerSocketHandlers(io, {
  userService,
  roomService,
  messageService,
  typingService,
  recordingService,
  presenceService,
  loginRateLimiter,
  messageRateLimiter,
  roomKeyRepository,
  aiService,
});

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
