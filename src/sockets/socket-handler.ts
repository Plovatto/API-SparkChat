import { logger } from '../config/logger.js';
import { errorPayload } from '../lib/app-error.js';
import type { AppSocket } from './events.js';

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
