import { errorPayload } from '../lib/app-error.js';
import type { AuthMethod } from '../modules/users/index.js';
import type { AppSocket } from './events.js';
import { userRoom } from './user-sockets.js';

export interface SocketSessionBinding {
  userId: string;
  authMethod: AuthMethod;
  sessionId: string;
}

export function requireSocketUserId(socket: AppSocket): string | null {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', errorPayload('auth.unauthenticated'));
    return null;
  }

  return userId;
}

async function leaveAllRooms(socket: AppSocket): Promise<void> {
  const rooms = [...socket.rooms].filter((room) => room !== socket.id);
  await Promise.all(
    rooms.map(async (room) => {
      await socket.leave(room);
    }),
  );
}

export async function bindSocketSession(socket: AppSocket, binding: SocketSessionBinding): Promise<void> {
  const previousUserId = socket.data.userId;
  if (previousUserId && previousUserId !== binding.userId) {
    await leaveAllRooms(socket);
  }

  socket.data.userId = binding.userId;
  socket.data.authMethod = binding.authMethod;
  socket.data.sessionId = binding.sessionId;
  delete socket.data.hidden;
  await socket.join(userRoom(binding.userId));
}

export async function clearSocketSession(socket: AppSocket): Promise<void> {
  delete socket.data.userId;
  delete socket.data.authMethod;
  delete socket.data.sessionId;
  delete socket.data.hidden;
  await leaveAllRooms(socket);
}
