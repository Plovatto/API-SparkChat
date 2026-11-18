import { logger } from '../config/logger.js';
import type { AppServer, AppSocket, SocketData } from './events.js';
import { isUserRoom, userRoom } from './user-sockets.js';

export type SessionValidator = (userId: string, sessionId: string) => Promise<boolean>;

export type MembershipFilter = (userId: string, roomIds: string[]) => Promise<Set<string>>;

interface StoredSession {
  sid: string;
  rooms: string[];
  data: unknown;
}

async function isRecoveredSessionActive(isSessionActive: SessionValidator, userId: string, sessionId: string): Promise<boolean> {
  try {
    return await isSessionActive(userId, sessionId);
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to revalidate recovered socket session');
    return false;
  }
}

async function keepCurrentMemberships(stored: StoredSession, filterMemberships: MembershipFilter): Promise<void> {
  const userId = (stored.data as SocketData | undefined)?.userId;
  if (!userId) {
    stored.rooms = stored.rooms.filter((room) => room === stored.sid);
    return;
  }

  const ownRoom = userRoom(userId);
  const chatRoomIds = stored.rooms.filter((room) => room !== stored.sid && !isUserRoom(room));

  let memberships: Set<string>;
  try {
    memberships = await filterMemberships(userId, chatRoomIds);
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to recheck room memberships of a recovered socket');
    memberships = new Set();
  }

  stored.rooms = stored.rooms.filter((room) => room === stored.sid || room === ownRoom || memberships.has(room));
}

export function guardSessionRecovery(io: AppServer, isSessionActive: SessionValidator, filterMemberships: MembershipFilter): void {
  const adapter = io.of('/').adapter;
  const restoreSession = adapter.restoreSession.bind(adapter);
  const sessions = (adapter as unknown as { sessions?: Map<string, StoredSession> }).sessions;

  adapter.restoreSession = async (pid, offset) => {
    const stored = sessions?.get(pid);
    if (stored) {
      await keepCurrentMemberships(stored, filterMemberships);
    }

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
