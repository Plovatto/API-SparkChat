import { logger } from '../config/logger.js';
import {
  registerMessageSocketHandlers,
  type MessageRateLimiter,
  type MessageService,
  type RecordingService,
  type RoomPresenceService,
  type TypingService,
} from '../modules/messages/index.js';
import { registerRoomSocketHandlers, type RoomService } from '../modules/rooms/index.js';
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
}

export function registerSocketHandlers(io: AppServer, deps: SocketDeps): void {
  io.on('connection', (socket: AppSocket) => {
    logger.info({ socketId: socket.id }, 'Client connected');

    registerUserSocketHandlers(io, socket, deps.userService, deps.roomService, deps.messageService, deps.loginRateLimiter);
    registerRoomSocketHandlers(io, socket, deps.roomService, deps.userService, deps.messageService);
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
    );

    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, reason }, 'Client disconnected');
    });
  });
}
