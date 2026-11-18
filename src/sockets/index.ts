import { logger } from '../config/logger.js';
import { registerClientEvents } from '../docs/socket-registry.js';
import type { AiService } from '../modules/ai/index.js';
import {
  registerMessageSocketHandlers,
  releaseSocketActivity,
  type MessageRateLimiter,
  type MessageService,
  type RecordingService,
  type RoomPresenceService,
  type TypingService,
} from '../modules/messages/index.js';
import {
  registerRoomSocketHandlers,
  type RoomActionRateLimiter,
  type RoomKeyRepository,
  type RoomService,
} from '../modules/rooms/index.js';
import { registerUserSocketHandlers, type LoginRateLimiter, type UserService } from '../modules/users/index.js';
import type { AppServer, AppSocket } from './events.js';
import { guardSessionRecovery, rejectRevokedRecovery } from './session-recovery.js';
import { handshakeAuthSchema, resolveHandshakeLocale } from './socket-locale.js';

registerClientEvents('connection', {
  'handshake.auth': handshakeAuthSchema,
});

export interface SocketDeps {
  userService: UserService;
  roomService: RoomService;
  messageService: MessageService;
  typingService: TypingService;
  recordingService: RecordingService;
  presenceService: RoomPresenceService;
  loginRateLimiter: LoginRateLimiter;
  messageRateLimiter: MessageRateLimiter;
  roomKeyRepository: RoomKeyRepository;
  aiService: AiService;
  roomRateLimiter: RoomActionRateLimiter;
}

export function registerSocketHandlers(io: AppServer, deps: SocketDeps): void {
  const { aiService } = deps;

  guardSessionRecovery(
    io,
    (userId, sessionId) => deps.userService.isSessionActive(userId, sessionId),
    (userId, roomIds) => deps.roomService.findParticipatingRoomIds(userId, roomIds),
  );

  io.on('connection', (socket: AppSocket) => {
    socket.data.locale = resolveHandshakeLocale(socket.handshake.auth);
    logger.info({ socketId: socket.id, recovered: socket.recovered }, 'Client connected');

    if (rejectRevokedRecovery(socket)) {
      return;
    }

    const activityServices = {
      typingService: deps.typingService,
      recordingService: deps.recordingService,
      presenceService: deps.presenceService,
    };

    registerUserSocketHandlers(io, socket, {
      userService: deps.userService,
      roomService: deps.roomService,
      messageService: deps.messageService,
      loginRateLimiter: deps.loginRateLimiter,
      onSessionReleased: ({ socket: released, userId }) => {
        releaseSocketActivity(io, released, activityServices, userId);
      },
    });

    registerRoomSocketHandlers(io, socket, {
      roomService: deps.roomService,
      userService: deps.userService,
      messageService: deps.messageService,
      roomKeyRepository: deps.roomKeyRepository,
      rateLimiter: deps.roomRateLimiter,
      onRoomCreated: ({ io: server, room, locale }) => {
        if (aiService.isAssistantRoom(room)) {
          void aiService.sendWelcomeMessage(server, room, locale);
        }
      },
      shouldResetInsteadOfDelete: (room) => aiService.isAssistantRoom(room),
      canReplaceRoomKey: (room, userId) => aiService.isAssistantRoom(room) && aiService.isAssistantUser(userId),
      onRoomKeyPublished: ({ io: server, room }) => {
        if (aiService.isAssistantRoom(room)) {
          void aiService.handleRoomKeyPublished(server, room);
        }
      },
    });

    registerMessageSocketHandlers(io, socket, {
      messageService: deps.messageService,
      roomService: deps.roomService,
      userService: deps.userService,
      ...activityServices,
      messageRateLimiter: deps.messageRateLimiter,
      onMessageSent: ({ io: server, room, message, locale }) => {
        if (message.type !== 'system' && aiService.isAssistantRoom(room)) {
          aiService.handleIncomingMessage(server, room, message, locale);
        }
      },
    });

    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, reason }, 'Client disconnected');
    });
  });
}
