import type { AppSocket } from './events.js';

const UNAUTHENTICATED_MESSAGE = 'Usuário não autenticado.';

export function requireSocketUserId(socket: AppSocket): string | null {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: UNAUTHENTICATED_MESSAGE });
    return null;
  }

  return userId;
}

export function clearSocketSession(socket: AppSocket): void {
  delete socket.data.userId;
  delete socket.data.authMethod;
  delete socket.data.sessionId;
}
