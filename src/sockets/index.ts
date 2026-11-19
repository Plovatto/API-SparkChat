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
import {
  disconnectRevokedSession,
  registerUserSocketHandlers,
  type LoginRateLimiter,
  type SessionRevocationNotifier,
  type UserService,
} from '../modules/users/index.js';
import type { AppServer, AppSocket } from './events.js';
import { guardSessionRecovery, rejectRevokedRecovery } from './session-recovery.js';
import { applySocketRateLimit, DEFAULT_SOCKET_EVENT_BUDGETS, type SocketEventBudgets } from './socket-rate-limit.js';
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
  sessionRevocations: SessionRevocationNotifier;
  messageRateLimiter: MessageRateLimiter;
  roomKeyRepository: RoomKeyRepository;
  aiService: AiService;
  roomRateLimiter: RoomActionRateLimiter;
  socketEventBudgets?: SocketEventBudgets;
}

function logHookFailure(hook: string) {
  return (err: unknown) => {
    logger.error({ err, hook }, 'Socket hook failed');
  };
}

export function registerSocketHandlers(io: AppServer, deps: SocketDeps): void {
  const { aiService } = deps;

  guardSessionRecovery(
    io,
    (userId, sessionId) => deps.userService.isSessionActive(userId, sessionId),
    (userId, roomIds) => deps.roomService.findParticipatingRoomIds(userId, roomIds),
  );

  deps.sessionRevocations.subscribe((revoked) => {
    disconnectRevokedSession(io, revoked);
  });

  io.on('connection', (socket: AppSocket) => {
    socket.data.locale = resolveHandshakeLocale(socket.handshake.auth);
    logger.info({ socketId: socket.id, recovered: socket.recovered }, 'Client connected');

    if (rejectRevokedRecovery(socket)) {
      return;
    }

    applySocketRateLimit(socket, deps.socketEventBudgets ?? DEFAULT_SOCKET_EVENT_BUDGETS);

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
          aiService.sendWelcomeMessage(server, room, locale).catch(logHookFailure('onRoomCreated'));
        }
      },
      shouldResetInsteadOfDelete: (room) => aiService.isAssistantRoom(room),
      onRoomKeyPublished: ({ io: server, room }) => {
        if (aiService.isAssistantRoom(room)) {
          aiService.handleRoomKeyPublished(server, room).catch(logHookFailure('onRoomKeyPublished'));
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
