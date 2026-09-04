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
  io.on('connection', (socket: AppSocket) => {
    logger.info({ socketId: socket.id }, 'Client connected');

    registerUserSocketHandlers(io, socket, deps.userService, deps.roomService, deps.messageService, deps.loginRateLimiter);
    registerRoomSocketHandlers(
      io,
      socket,
      deps.roomService,
      deps.userService,
      deps.messageService,
      deps.roomKeyRepository,
      ({ io: server, room }) => {
        if (deps.aiService.isAssistantRoom(room)) {
          void deps.aiService.sendWelcomeMessage(server, room);
        }
      },
      (room) => deps.aiService.isAssistantRoom(room),
    );
    registerMessageSocketHandlers(
      io,
      socket,
      deps.messageService,
      deps.roomService,
      deps.userService,
      deps.typingService,
      deps.recordingService,
      deps.presenceService,
      deps.messageRateLimiter,
      ({ io: server, room, message }) => {
        if (message.type !== 'system' && deps.aiService.isAssistantRoom(room)) {
          deps.aiService.handleIncomingMessage(server, room, message);
        }
      },
    );

    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, reason }, 'Client disconnected');
    });
  });
}
