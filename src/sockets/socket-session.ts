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

function clearSocketIdentity(socket: AppSocket): void {
  delete socket.data.userId;
  delete socket.data.authMethod;
  delete socket.data.sessionId;
  delete socket.data.hidden;
  delete socket.data.inattentive;
}

export async function bindSocketSession(socket: AppSocket, binding: SocketSessionBinding): Promise<boolean> {
  if (socket.disconnected) {
    return false;
  }

  const previousUserId = socket.data.userId;
  if (previousUserId && previousUserId !== binding.userId) {
    await leaveAllRooms(socket);
    if (socket.disconnected) {
      clearSocketIdentity(socket);
      return false;
    }
  }

  socket.data.userId = binding.userId;
  socket.data.authMethod = binding.authMethod;
  socket.data.sessionId = binding.sessionId;
  delete socket.data.hidden;
  delete socket.data.inattentive;
  await socket.join(userRoom(binding.userId));

  if (socket.disconnected) {
    clearSocketIdentity(socket);
    await socket.leave(userRoom(binding.userId));
    return false;
  }

  return true;
}

export async function clearSocketSession(socket: AppSocket): Promise<void> {
  clearSocketIdentity(socket);
  await leaveAllRooms(socket);
}
