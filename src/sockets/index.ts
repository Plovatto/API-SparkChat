import { logger } from '../config/logger.js';
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
      onRoomCreated: ({ io: server, room }) => {
        if (aiService.isAssistantRoom(room)) {
          void aiService.sendWelcomeMessage(server, room);
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
      onMessageSent: ({ io: server, room, message }) => {
        if (message.type !== 'system' && aiService.isAssistantRoom(room)) {
          aiService.handleIncomingMessage(server, room, message);
        }
      },
    });

    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, reason }, 'Client disconnected');
    });
  });
}
