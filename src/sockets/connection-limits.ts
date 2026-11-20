import { ipKey } from '../lib/client-network.js';
import { logger } from '../config/logger.js';
import { errorPayload } from '../lib/app-error.js';
import { getClientIp } from '../config/client-ip.js';
import type { AppServer, AppSocket } from './events.js';
import { listUserSockets } from './user-sockets.js';

export interface SocketConnectionLimits {
  maxPerIp: number;
  maxPerUser: number;
  unauthenticatedTimeoutMs: number;
}

export const DEFAULT_SOCKET_CONNECTION_LIMITS: SocketConnectionLimits = {
  maxPerIp: 100,
  maxPerUser: 10,
  unauthenticatedTimeoutMs: 2 * 60 * 1000,
};

export class SocketConnectionTracker {
  private readonly countsByIp = new Map<string, number>();

  constructor(private readonly maxPerIp: number) {}

  admit(ip: string): boolean {
    const key = ipKey(ip);
    const current = this.countsByIp.get(key) ?? 0;
    if (current >= this.maxPerIp) {
      return false;
    }
    this.countsByIp.set(key, current + 1);
    return true;
  }

  release(ip: string): void {
    const key = ipKey(ip);
    const current = this.countsByIp.get(key) ?? 0;
    if (current <= 1) {
      this.countsByIp.delete(key);
      return;
    }
    this.countsByIp.set(key, current - 1);
  }

  get trackedIps(): number {
    return this.countsByIp.size;
  }
}

export function admitSocketConnection(socket: AppSocket, tracker: SocketConnectionTracker, limits: SocketConnectionLimits): boolean {
  const ip = getClientIp(socket.request);
  if (!tracker.admit(ip)) {
    logger.warn({ socketId: socket.id }, 'Socket rejected: too many connections from address');
    socket.emit('error', errorPayload('rateLimit.socket'));
    socket.disconnect(true);
    return false;
  }

  let timer: NodeJS.Timeout | null = null;
  if (limits.unauthenticatedTimeoutMs > 0) {
    timer = setTimeout(() => {
      if (!socket.data.userId) {
        socket.conn.close();
      }
    }, limits.unauthenticatedTimeoutMs);
    timer.unref();
  }

  socket.on('disconnect', () => {
    if (timer) {
      clearTimeout(timer);
    }
    tracker.release(ip);
  });
  return true;
}

export function enforceUserSocketCap(io: AppServer, userId: string, maxPerUser: number): void {
  const sockets = listUserSockets(io, userId);
  const excess = sockets.length - maxPerUser;
  if (excess <= 0) {
    return;
  }

  logger.warn({ userId, sockets: sockets.length }, 'Too many sockets for user; closing the oldest');
  for (const socket of sockets.slice(0, excess)) {
    socket.emit('error', errorPayload('rateLimit.socket'));
    socket.disconnect(true);
  }
}
