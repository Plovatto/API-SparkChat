import { logger } from '../config/logger.js';
import type { AppServer, AppSocket } from './events.js';

export function registerSocketHandlers(io: AppServer): void {
  io.on('connection', (socket: AppSocket) => {
    logger.info({ socketId: socket.id }, 'Client connected');

    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, reason }, 'Client disconnected');
    });
  });
}
