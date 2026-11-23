import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { webPushVapidConfig } from './config/web-push-env.js';
import { db } from './database/turso-client.js';
import { runMigrations } from './database/migrate.js';
import { CallBudget, CallRateLimiter, CallRepository, CallService, createCloudflareTurnProvider } from './modules/calls/index.js';
import { AvatarRepository, AvatarService } from './modules/avatars/index.js';
import { createGifProvider } from './modules/gifs/index.js';
import { AiService, AiUsageLimiter, AiUsageRepository, createGeminiRouter, currentUsageDate, ensureAssistantUser, loadAssistantIdentity } from './modules/ai/index.js';
import { httpLinkPreviewFetcher, LinkPreviewRepository, LinkPreviewService } from './modules/link-preview/index.js';
import {
  MessageRateLimiter,
  MessageRepository,
  MessageService,
  RecordingService,
  RoomPresenceService,
  TypingService,
} from './modules/messages/index.js';
import { setupTransparency } from './modules/transparency/index.js';
import { createWebPushSender, PushRateLimiter, PushRepository, PushService } from './modules/push/index.js';
import { notifyRoomRotations, RoomActionRateLimiter, RoomKeyRepository, RoomRepository, RoomService } from './modules/rooms/index.js';
import { isSessionLive, LoginRateLimiter, SessionRevocationNotifier, UserRepository, UserService, UserSessionRepository } from './modules/users/index.js';
import { registerSocketHandlers } from './sockets/index.js';
import { startSessionExpirySweep } from './sockets/session-expiry.js';
import { hasVisibleUserSocket } from './sockets/user-sockets.js';
import { SOCKET_MAX_HTTP_BUFFER_SIZE, SOCKET_PER_MESSAGE_DEFLATE } from './sockets/socket-options.js';
import { createR2ObjectStorage } from './storage/r2-object-storage.js';
import { StorageQuota } from './storage/storage-quota.js';
import { StorageUsageRepository } from './storage/storage-usage.repository.js';
import { ExpiredUploadSweeper } from './storage/expired-upload-sweeper.js';
import { OrphanUploadSweeper } from './storage/orphan-upload-sweeper.js';
import { UploadRegistry } from './storage/upload-registry.js';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from './sockets/events.js';

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});

await runMigrations(db);

const userRepository = new UserRepository(db);
const userSessionRepository = new UserSessionRepository(db);
const userService = new UserService(userRepository, userSessionRepository, env.RECOVERY_FILE_SECRET);
const loginRateLimiter = new LoginRateLimiter();
setInterval(() => loginRateLimiter.sweep(), 60_000).unref();
const sessionRevocations = new SessionRevocationNotifier();

const objectStorage = createR2ObjectStorage({
  accountId: env.R2_ACCOUNT_ID,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  bucketName: env.R2_BUCKET_NAME,
  publicBaseUrl: env.R2_PUBLIC_BASE_URL,
});
const storageUsageRepository = new StorageUsageRepository(db);
const storageQuota = new StorageQuota(storageUsageRepository);
const uploadRegistry = new UploadRegistry(db);
new OrphanUploadSweeper(uploadRegistry, objectStorage, storageQuota).start();
new ExpiredUploadSweeper(uploadRegistry, objectStorage, storageQuota).start();

const messageRepository = new MessageRepository(db);
const messageService = new MessageService(messageRepository, userService, objectStorage, storageQuota, uploadRegistry);

const roomRepository = new RoomRepository(db);
const roomService = new RoomService(roomRepository, userService, messageService);
const roomKeyRepository = new RoomKeyRepository(db);
const avatarService = new AvatarService(new AvatarRepository(db), uploadRegistry, objectStorage, storageQuota);

const { purgedParticipants, clearedCodes } = await roomService.normalizeMembershipsAndRoomCodes();
if (purgedParticipants > 0 || clearedCodes > 0) {
  logger.info({ purgedParticipants, clearedCodes }, 'Room memberships and group room codes normalized');
}

const typingService = new TypingService();
const recordingService = new RecordingService();
const presenceService = new RoomPresenceService();
const messageRateLimiter = new MessageRateLimiter();
const roomRateLimiter = new RoomActionRateLimiter();

const linkPreviewRepository = new LinkPreviewRepository(db);
const linkPreviewService = new LinkPreviewService(linkPreviewRepository, httpLinkPreviewFetcher, env.RECOVERY_FILE_SECRET);
await linkPreviewService.purgeExpired().catch((error: unknown) => logger.warn({ err: error }, 'Link preview cache purge failed'));

const assistantIdentity = await loadAssistantIdentity(env.AI_ASSISTANT_PRIVATE_KEY);
const assistantRotations = await ensureAssistantUser(userRepository, assistantIdentity);
const aiRouter = createGeminiRouter(env.GEMINI_API_KEY);
const aiUsageRepository = new AiUsageRepository(db);
await aiUsageRepository
  .purgeBefore(currentUsageDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)))
  .catch((error: unknown) => logger.warn({ err: error }, 'AI usage purge failed'));
const aiUsageLimiter = new AiUsageLimiter(aiUsageRepository);
const aiService = new AiService(
  assistantIdentity,
  roomKeyRepository,
  messageService,
  typingService,
  presenceService,
  aiRouter,
  aiUsageLimiter,
  objectStorage,
  userService,
);

const gifProvider = createGifProvider({ nodeEnv: env.NODE_ENV, provider: env.GIF_PROVIDER, klipyApiKey: env.KLIPY_API_KEY });

const app = createApp({
  userService,
  loginRateLimiter,
  sessionRevocations,
  linkPreviewService,
  objectStorage,
  storageQuota,
  uploadRegistry,
  gifProvider,
  callDecline: (input) => callService.declineWithToken(input),
});
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
  maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE,
  perMessageDeflate: SOCKET_PER_MESSAGE_DEFLATE,
  pingInterval: 20000,
  pingTimeout: 25000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 5 * 60 * 1000,
    skipMiddlewares: true,
  },
});

notifyRoomRotations(io, assistantRotations);

const transparency = await setupTransparency(
  { ...env, nodeEnv: process.env.NODE_ENV },
  db,
  {
    findKeys: async (userId) => {
      const user = await userRepository.findById(userId);
      return user?.e2ePublicKey ? { publicKey: user.e2ePublicKey, signingPublicKey: user.e2eSigningPublicKey ?? null } : null;
    },
    listKeyedUsers: (afterId, limit) => userRepository.listKeyedUsers(afterId, limit),
  },
  (listener) => userService.onKeysChanged(listener),
);
const transparencyService = transparency?.service ?? null;

const callRepository = new CallRepository(db);
const turnProvider =
  env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN
    ? createCloudflareTurnProvider({ keyId: env.CLOUDFLARE_TURN_KEY_ID, apiToken: env.CLOUDFLARE_TURN_API_TOKEN })
    : null;
const vapid = webPushVapidConfig(env);
const pushService = new PushService({
  publicKey: vapid?.publicKey ?? null,
  sender: vapid ? createWebPushSender(vapid) : null,
  repository: new PushRepository(db),
  limiter: new PushRateLimiter(),
  hasVisibleClient: (userId) => hasVisibleUserSocket(io, userId),
  isSessionLive: (session, now) => isSessionLive(session, now),
});
pushService.startMaintenance();
logger.info(`Web Push: ${pushService.enabled ? 'enabled' : 'disabled (WEB_PUSH_* not set)'}`);

const callService = new CallService(io, callRepository, roomService, messageService, new CallBudget(callRepository), new CallRateLimiter(), turnProvider, {
  push: pushService,
});
callService.startMaintenance();

registerSocketHandlers(io, {
  userService,
  roomService,
  messageService,
  typingService,
  recordingService,
  presenceService,
  loginRateLimiter,
  sessionRevocations,
  messageRateLimiter,
  roomRateLimiter,
  roomKeyRepository,
  aiService,
  callService,
  pushService,
  avatarService,
  transparencyService,
});

startSessionExpirySweep(io, (userId, sessionId) => userService.isSessionWithinLifetime(userId, sessionId));

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
