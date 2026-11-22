import { logger } from '../config/logger.js';
import type { AppServer, AppSocket } from './events.js';

export const SESSION_EXPIRY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export type SessionLivenessCheck = (userId: string, sessionId: string) => Promise<boolean>;

function sessionKey(userId: string, sessionId: string): string {
  return `${userId}\u0000${sessionId}`;
}

export async function sweepExpiredSocketSessions(io: AppServer, isSessionLive: SessionLivenessCheck): Promise<void> {
  const socketsBySession = new Map<string, { userId: string; sessionId: string; sockets: AppSocket[] }>();
  for (const socket of io.sockets.sockets.values()) {
    const { userId, sessionId } = socket.data;
    if (!userId || !sessionId) {
      continue;
    }
    const key = sessionKey(userId, sessionId);
    const entry = socketsBySession.get(key) ?? { userId, sessionId, sockets: [] };
    entry.sockets.push(socket);
    socketsBySession.set(key, entry);
  }

  for (const { userId, sessionId, sockets } of socketsBySession.values()) {
    let live: boolean;
    try {
      live = await isSessionLive(userId, sessionId);
    } catch (err) {
      logger.error({ err }, 'Failed to check socket session liveness');
      continue;
    }
    if (live) {
      continue;
    }
    for (const socket of sockets) {
      if (!socket.connected || socket.data.userId !== userId || socket.data.sessionId !== sessionId) {
        continue;
      }
      socket.emit('user:session-revoked');
      socket.disconnect(true);
    }
  }
}

export function startSessionExpirySweep(io: AppServer, isSessionLive: SessionLivenessCheck, intervalMs = SESSION_EXPIRY_SWEEP_INTERVAL_MS): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    sweepExpiredSocketSessions(io, isSessionLive)
      .catch((err: unknown) => {
        logger.error({ err }, 'Socket session expiry sweep failed');
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
