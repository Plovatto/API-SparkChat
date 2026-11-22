import { logger } from '../config/logger.js';
import { errorPayload } from '../lib/app-error.js';
import type { AppSocket } from './events.js';
import { extractErrorPayload } from './socket-errors.js';
import { requireSocketUserId } from './socket-session.js';

function reportHandlerFailure(socket: AppSocket, event: string, error: unknown): void {
  logger.error({ err: error, event, socketId: socket.id }, 'Socket handler failed');
  if (socket.connected) {
    socket.emit('error', { ...errorPayload('internal.unexpected'), event });
  }
}

export function runSocketHandler(socket: AppSocket, event: string, handler: () => unknown): void {
  try {
    const result = handler();
    if (result instanceof Promise) {
      result.catch((error: unknown) => {
        reportHandlerFailure(socket, event, error);
      });
    }
  } catch (error) {
    reportHandlerFailure(socket, event, error);
  }
}

export function runAuthedSocketHandler(socket: AppSocket, event: string, work: (userId: string) => Promise<void>): void {
  runSocketHandler(socket, event, async () => {
    const userId = requireSocketUserId(socket);
    if (!userId) {
      return;
    }
    try {
      await work(userId);
    } catch (error) {
      socket.emit('error', { ...extractErrorPayload(error), event });
    }
  });
}
