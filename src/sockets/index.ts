import { logger } from '../config/logger.js';
import { registerClientEvents } from '../docs/socket-registry.js';
import type { AiService } from '../modules/ai/index.js';
import { registerAvatarSocketHandlers, type AvatarService } from '../modules/avatars/index.js';
import { registerCallSocketHandlers, type CallService } from '../modules/calls/index.js';
import {
  registerMessageSocketHandlers,
  releaseSocketActivity,
  type MessageRateLimiter,
  type MessageService,
  type RecordingService,
  type RoomPresenceService,
  type TypingService,
} from '../modules/messages/index.js';
import type { ScheduleSocketDeps } from '../modules/messages/message.schedule.socket.js';
import { registerPushSocketHandlers, type PushService } from '../modules/push/index.js';
import { registerTransparencySocketHandlers, type TransparencyService } from '../modules/transparency/index.js';
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
import { createMessageSentHook } from './message-sent-hook.js';
import { guardSessionRecovery, rejectRevokedRecovery } from './session-recovery.js';
import { admitSocketConnection, DEFAULT_SOCKET_CONNECTION_LIMITS, enforceUserSocketCap, SocketConnectionTracker, type SocketConnectionLimits } from './connection-limits.js';
import { applySocketRateLimit, DEFAULT_SOCKET_EVENT_BUDGETS, UserEventLimiters, type SocketEventBudgets } from './socket-rate-limit.js';
import { handshakeAuthSchema, resolveHandshakeLocale, resolveHandshakeTimeZone } from './socket-locale.js';

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
  scheduledMessages?: ScheduleSocketDeps['scheduledMessages'];
  roomRateLimiter: RoomActionRateLimiter;
  callService: CallService;
  pushService: PushService;
  avatarService: AvatarService;
  transparencyService?: TransparencyService | null;
  socketEventBudgets?: SocketEventBudgets;
  socketConnectionLimits?: SocketConnectionLimits;
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

  const eventBudgets = deps.socketEventBudgets ?? DEFAULT_SOCKET_EVENT_BUDGETS;
  const connectionLimits = deps.socketConnectionLimits ?? DEFAULT_SOCKET_CONNECTION_LIMITS;
  const userEventLimiters = new UserEventLimiters(eventBudgets);
  const connectionTracker = new SocketConnectionTracker(connectionLimits.maxPerIp);

  io.on('connection', (socket: AppSocket) => {
    if (!admitSocketConnection(socket, connectionTracker, connectionLimits)) {
      return;
    }

    socket.data.locale = resolveHandshakeLocale(socket.handshake.auth);
    const handshakeTimeZone = resolveHandshakeTimeZone(socket.handshake.auth);
    if (handshakeTimeZone) {
      socket.data.timeZone = handshakeTimeZone;
    }
    logger.info({ socketId: socket.id, recovered: socket.recovered }, 'Client connected');

    if (rejectRevokedRecovery(socket)) {
      return;
    }

    applySocketRateLimit(socket, eventBudgets, Date.now, userEventLimiters);

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
        deps.callService.releaseSocket(released.id, userId).catch(logHookFailure('onSessionReleased'));
      },
      onAuthenticated: ({ socket: authenticated, userId }) => {
        enforceUserSocketCap(io, userId, connectionLimits.maxPerUser);
        deps.callService
          .getConfig()
          .then((config) => authenticated.emit('call:config', config))
          .catch(logHookFailure('onAuthenticated'));
        authenticated.emit('push:config', deps.pushService.getConfig());
        if (deps.transparencyService) {
          authenticated.emit('kt:config', deps.transparencyService.getConfig());
        }
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
      onUserBlocked: ({ userId, blockedUserId }) => {
        deps.callService.endCallsBetween(userId, blockedUserId).catch(logHookFailure('onUserBlocked'));
      },
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
      isAssistantRoom: (room) => aiService.isAssistantRoom(room),
      scheduledMessages: deps.scheduledMessages,
      onMessageSent: createMessageSentHook({ aiService, pushService: deps.pushService }),
    });

    registerCallSocketHandlers(socket, { callService: deps.callService });
    registerPushSocketHandlers(socket, { pushService: deps.pushService });
    registerAvatarSocketHandlers(io, socket, { avatarService: deps.avatarService, roomService: deps.roomService });
    if (deps.transparencyService) {
      registerTransparencySocketHandlers(socket, {
        transparencyService: deps.transparencyService,
        getContactIds: (userId) => deps.roomService.getContactIds(userId),
      });
    }

    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, reason }, 'Client disconnected');
    });
  });
}
