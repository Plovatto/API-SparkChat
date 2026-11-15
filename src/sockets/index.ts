import { logger } from '../config/logger.js';
import { registerClientEvents } from '../docs/socket-registry.js';
import type { AiService } from '../modules/ai/index.js';
import {
  registerMessageSocketHandlers,
  type MessageRateLimiter,
  type MessageService,
  type RecordingService,
  type RoomPresenceService,
  type TypingService,
} from '../modules/messages/index.js';
import { registerRoomSocketHandlers, type RoomKeyRepository, type RoomService } from '../modules/rooms/index.js';
import { registerUserSocketHandlers, type LoginRateLimiter, type UserService } from '../modules/users/index.js';
import type { AppServer, AppSocket } from './events.js';
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
}

export function registerSocketHandlers(io: AppServer, deps: SocketDeps): void {
  const { aiService } = deps;

  io.on('connection', (socket: AppSocket) => {
    socket.data.locale = resolveHandshakeLocale(socket.handshake.auth);
    logger.info({ socketId: socket.id }, 'Client connected');

    registerUserSocketHandlers(io, socket, {
      userService: deps.userService,
      roomService: deps.roomService,
      messageService: deps.messageService,
      loginRateLimiter: deps.loginRateLimiter,
    });

    registerRoomSocketHandlers(io, socket, {
      roomService: deps.roomService,
      userService: deps.userService,
      messageService: deps.messageService,
      roomKeyRepository: deps.roomKeyRepository,
      onRoomCreated: ({ io: server, room, locale }) => {
        if (aiService.isAssistantRoom(room)) {
          void aiService.sendWelcomeMessage(server, room, locale);
        }
      },
      shouldResetInsteadOfDelete: (room) => aiService.isAssistantRoom(room),
    });

    registerMessageSocketHandlers(io, socket, {
      messageService: deps.messageService,
      roomService: deps.roomService,
      userService: deps.userService,
      typingService: deps.typingService,
      recordingService: deps.recordingService,
      presenceService: deps.presenceService,
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
