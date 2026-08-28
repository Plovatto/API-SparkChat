import { logger } from '../config/logger.js';
import { registerRoomSocketHandlers, type RoomService } from '../modules/rooms/index.js';
import { registerUserSocketHandlers, type UserService } from '../modules/users/index.js';
import type { AppServer, AppSocket } from './events.js';

export interface SocketDeps {
  userService: UserService;
  roomService: RoomService;
}

export function registerSocketHandlers(io: AppServer, deps: SocketDeps): void {
  io.on('connection', (socket: AppSocket) => {
    logger.info({ socketId: socket.id }, 'Client connected');

    registerUserSocketHandlers(io, socket, deps.userService);
    registerRoomSocketHandlers(io, socket, deps.roomService, deps.userService);

    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, reason }, 'Client disconnected');
    });
  });
}
