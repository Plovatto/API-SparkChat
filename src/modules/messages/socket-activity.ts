import type { AppServer, AppSocket } from '../../sockets/events.js';
import { listUserSockets } from '../../sockets/user-sockets.js';

export type SocketActivityKind = 'viewing' | 'typing' | 'recording';

export type ReleasedSocketActivity = Record<SocketActivityKind, string[]>;

const activityBySocket = new WeakMap<AppSocket, Map<SocketActivityKind, Set<string>>>();

function marksOf(socket: AppSocket, kind: SocketActivityKind): Set<string> | undefined {
  return activityBySocket.get(socket)?.get(kind);
}

export function markSocketActivity(socket: AppSocket, kind: SocketActivityKind, roomId: string): void {
  const activity = activityBySocket.get(socket) ?? new Map<SocketActivityKind, Set<string>>();
  const rooms = activity.get(kind) ?? new Set<string>();
  rooms.add(roomId);
  activity.set(kind, rooms);
  activityBySocket.set(socket, activity);
}

export function unmarkSocketActivity(socket: AppSocket, kind: SocketActivityKind, roomId: string): void {
  marksOf(socket, kind)?.delete(roomId);
}

export function isActivityHeldByOtherSocket(
  io: AppServer,
  socket: AppSocket,
  userId: string,
  kind: SocketActivityKind,
  roomId: string,
): boolean {
  return listUserSockets(io, userId).some((other) => other.id !== socket.id && marksOf(other, kind)?.has(roomId) === true);
}

export function releaseAllSocketActivity(io: AppServer, socket: AppSocket, userId: string): ReleasedSocketActivity {
  const activity = activityBySocket.get(socket);
  activityBySocket.delete(socket);

  const released: ReleasedSocketActivity = { viewing: [], typing: [], recording: [] };
  if (!activity) {
    return released;
  }

  for (const [kind, rooms] of activity) {
    released[kind] = [...rooms].filter((roomId) => !isActivityHeldByOtherSocket(io, socket, userId, kind, roomId));
  }
  return released;
}
