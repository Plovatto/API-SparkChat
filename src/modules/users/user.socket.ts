import { z } from 'zod';
import type { AppServer, AppSocket } from '../../sockets/events.js';
import type { UserService } from './user.service.js';

const joinPayloadSchema = z.object({
  nickname: z.string().trim().min(1).optional(),
  avatar: z.number().int().min(0).optional(),
  loginCode: z.string().trim().min(1).optional().nullable(),
});

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Erro inesperado.';
}

export function registerUserSocketHandlers(
  io: AppServer,
  socket: AppSocket,
  userService: UserService,
): void {
  socket.on('user:join', (payload) => {
    void handleJoin(socket, userService, payload);
  });

  socket.on('disconnect', () => {
    void handleDisconnect(io, socket, userService);
  });
}

async function handleJoin(
  socket: AppSocket,
  userService: UserService,
  payload: unknown,
): Promise<void> {
  try {
    const input = joinPayloadSchema.parse(payload);
    const user = await userService.joinOrCreate({ ...input, socketId: socket.id });

    socket.data.userId = user.id;

    socket.emit('user:registered', { user: userService.toPublicUser(user) });
    socket.broadcast.emit('user:online', {
      userId: user.id,
      nickname: user.nickname,
      avatar: user.avatar,
    });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleDisconnect(
  io: AppServer,
  socket: AppSocket,
  userService: UserService,
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  const updated = await userService.setStatus(userId, 'offline');
  if (!updated) {
    return;
  }

  io.emit('user:offline', {
    userId: updated.id,
    user: { id: updated.id, status: updated.status, lastSeen: updated.lastSeen },
  });
}
