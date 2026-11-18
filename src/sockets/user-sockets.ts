import type { AppServer, AppSocket } from './events.js';

const USER_ROOM_PREFIX = 'user:';

export function userRoom(userId: string): string {
  return `${USER_ROOM_PREFIX}${userId}`;
}

export function isUserRoom(roomId: string): boolean {
  return roomId.startsWith(USER_ROOM_PREFIX);
}

export function emitToUser(io: AppServer, userId: string) {
  return io.to(userRoom(userId));
}

export function listUserSockets(io: AppServer, userId: string): AppSocket[] {
  const socketIds = io.sockets.adapter.rooms.get(userRoom(userId));
  if (!socketIds) {
    return [];
  }

  const sockets: AppSocket[] = [];
  for (const socketId of socketIds) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      sockets.push(socket);
    }
  }
  return sockets;
}

export function findSocketsBoundToUser(io: AppServer, userId: string): AppSocket[] {
  const found = new Map<string, AppSocket>();
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.userId === userId) {
      found.set(socket.id, socket);
    }
  }
  for (const socket of listUserSockets(io, userId)) {
    found.set(socket.id, socket);
  }
  return [...found.values()];
}

export function hasVisibleUserSocket(io: AppServer, userId: string): boolean {
  return listUserSockets(io, userId).some((socket) => socket.data.hidden !== true);
}

export async function joinUserSocketsToRoom(io: AppServer, userId: string, roomId: string): Promise<void> {
  await Promise.all(
    listUserSockets(io, userId).map(async (socket) => {
      await socket.join(roomId);
    }),
  );
}

export async function removeUserSocketsFromRoom(io: AppServer, userId: string, roomId: string): Promise<void> {
  await Promise.all(
    listUserSockets(io, userId).map(async (socket) => {
      await socket.leave(roomId);
    }),
  );
}
