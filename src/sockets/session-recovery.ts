import { logger } from '../config/logger.js';
import type { AppServer, AppSocket, SocketData } from './events.js';

export type SessionValidator = (userId: string, sessionId: string) => Promise<boolean>;

async function isRecoveredSessionActive(isSessionActive: SessionValidator, userId: string, sessionId: string): Promise<boolean> {
  try {
    return await isSessionActive(userId, sessionId);
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to revalidate recovered socket session');
    return false;
  }
}

export function guardSessionRecovery(io: AppServer, isSessionActive: SessionValidator): void {
  const adapter = io.of('/').adapter;
  const restoreSession = adapter.restoreSession.bind(adapter);

  adapter.restoreSession = async (pid, offset) => {
    const session = await restoreSession(pid, offset);
    if (!session) {
      return session;
    }

    const data = session.data as SocketData;
    if (!data.userId || !data.sessionId) {
      return session;
    }

    if (await isRecoveredSessionActive(isSessionActive, data.userId, data.sessionId)) {
      return session;
    }

    const revokedData: SocketData = { sessionRevoked: true };
    return { ...session, rooms: [], missedPackets: [], data: revokedData };
  };
}

export function rejectRevokedRecovery(socket: AppSocket): boolean {
  if (socket.data.sessionRevoked !== true) {
    return false;
  }

  delete socket.data.sessionRevoked;
  socket.emit('user:session-revoked');
  socket.disconnect(true);
  return true;
}
