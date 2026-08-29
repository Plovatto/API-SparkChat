import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { registerSocketEvent } from '../../docs/socket-registry.js';
import type { AppServer, AppSocket } from '../../sockets/events.js';
import type { UserService } from './user.service.js';

const joinPayloadSchema = z.object({
  nickname: z.string().trim().min(1).optional(),
  avatar: z.number().int().min(0).optional(),
  loginCode: z.string().trim().min(1).optional().nullable(),
});

const updateProfilePayloadSchema = z.object({
  nickname: z.string().trim().min(2).max(20),
  avatar: z.number().int().min(0),
});

registerSocketEvent({
  event: 'user:join',
  direction: 'client-to-server',
  module: 'users',
  payloadSchema: zodToJsonSchema(joinPayloadSchema),
});
registerSocketEvent({
  event: 'user:update-profile',
  direction: 'client-to-server',
  module: 'users',
  payloadSchema: zodToJsonSchema(updateProfilePayloadSchema),
});
registerSocketEvent({ event: 'user:registered', direction: 'server-to-client', module: 'users' });
registerSocketEvent({ event: 'user:online', direction: 'server-to-client', module: 'users' });
registerSocketEvent({ event: 'user:offline', direction: 'server-to-client', module: 'users' });
registerSocketEvent({ event: 'user:profile-updated', direction: 'server-to-client', module: 'users' });
registerSocketEvent({ event: 'user:profile-updated-success', direction: 'server-to-client', module: 'users' });
registerSocketEvent({ event: 'error', direction: 'server-to-client', module: 'users' });

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

  socket.on('user:update-profile', (payload) => {
    void handleUpdateProfile(io, socket, userService, payload);
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

async function handleUpdateProfile(
  io: AppServer,
  socket: AppSocket,
  userService: UserService,
  payload: unknown,
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { nickname, avatar } = updateProfilePayloadSchema.parse(payload);
    const updated = await userService.updateProfile(userId, { nickname, avatar });

    if (!updated) {
      socket.emit('error', { message: 'Usuário não encontrado.' });
      return;
    }

    io.emit('user:profile-updated', { userId: updated.id, nickname: updated.nickname, avatar: updated.avatar });
    socket.emit('user:profile-updated-success', { user: userService.toPublicUser(updated) });
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
