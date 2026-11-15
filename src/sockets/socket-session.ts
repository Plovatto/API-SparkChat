import { errorPayload } from '../lib/app-error.js';
import type { AppSocket } from './events.js';

export function requireSocketUserId(socket: AppSocket): string | null {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', errorPayload('auth.unauthenticated'));
    return null;
  }

  return userId;
}

export function clearSocketSession(socket: AppSocket): void {
  delete socket.data.userId;
  delete socket.data.authMethod;
  delete socket.data.sessionId;
}
