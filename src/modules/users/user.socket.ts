import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { registerSocketEvent } from '../../docs/socket-registry.js';
import type { AppServer, AppSocket } from '../../sockets/events.js';
import type { MessageService } from '../messages/index.js';
import type { RoomService } from '../rooms/index.js';
import { describeDevice } from './user.device.js';
import {
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
  PASSWORD_MIN_LENGTH,
  STATUS_TEXT_MAX_LENGTH,
  userThemeSchema,
} from './user.model.js';
import type { UserService } from './user.service.js';

const joinPayloadSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('register'),
    nickname: z.string().trim().min(NICKNAME_MIN_LENGTH).max(NICKNAME_MAX_LENGTH),
    avatar: z.number().int().min(0),
    password: z.string().min(PASSWORD_MIN_LENGTH),
  }),
  z.object({
    mode: z.literal('resume'),
    userId: z.string().trim().min(1),
    sessionToken: z.string().trim().min(1),
  }),
]);

const updateProfilePayloadSchema = z.object({
  nickname: z.string().trim().min(NICKNAME_MIN_LENGTH).max(NICKNAME_MAX_LENGTH),
  avatar: z.number().int().min(0),
});

const updateStatusTextPayloadSchema = z.object({
  statusText: z.string().max(STATUS_TEXT_MAX_LENGTH),
});

const visibilityPayloadSchema = z.object({
  visible: z.boolean(),
});

const changePasswordPayloadSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH),
});

const revokeSessionPayloadSchema = z.object({
  sessionId: z.string().trim().min(1),
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
registerSocketEvent({
  event: 'user:update-status-text',
  direction: 'client-to-server',
  module: 'users',
  payloadSchema: zodToJsonSchema(updateStatusTextPayloadSchema),
});
registerSocketEvent({
  event: 'user:update-theme',
  direction: 'client-to-server',
  module: 'users',
  payloadSchema: zodToJsonSchema(userThemeSchema),
});
registerSocketEvent({
  event: 'user:visibility',
  direction: 'client-to-server',
  module: 'users',
  payloadSchema: zodToJsonSchema(visibilityPayloadSchema),
});
registerSocketEvent({
  event: 'user:change-password',
  direction: 'client-to-server',
  module: 'users',
  payloadSchema: zodToJsonSchema(changePasswordPayloadSchema),
});
registerSocketEvent({ event: 'user:regenerate-recovery-file', direction: 'client-to-server', module: 'users' });
registerSocketEvent({ event: 'user:list-sessions', direction: 'client-to-server', module: 'users' });
registerSocketEvent({
  event: 'user:revoke-session',
  direction: 'client-to-server',
  module: 'users',
  payloadSchema: zodToJsonSchema(revokeSessionPayloadSchema),
});
registerSocketEvent({ event: 'user:registered', direction: 'server-to-client', module: 'users' });
registerSocketEvent({ event: 'user:resumed', direction: 'server-to-client', module: 'users' });
registerSocketEvent({ event: 'user:online', direction: 'server-to-client', module: 'users' });
registerSocketEvent({ event: 'user:offline', direction: 'server-to-client', module: 'users' });
registerSocketEvent({ event: 'user:profile-updated', direction: 'server-to-client', module: 'users' });
registerSocketEvent({ event: 'user:profile-updated-success', direction: 'server-to-client', module: 'users' });
registerSocketEvent({ event: 'user:password-changed', direction: 'server-to-client', module: 'users' });
registerSocketEvent({ event: 'user:recovery-file-regenerated', direction: 'server-to-client', module: 'users' });
registerSocketEvent({ event: 'user:sessions', direction: 'server-to-client', module: 'users' });
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
  roomService: RoomService,
  messageService: MessageService,
): void {
  socket.on('user:join', (payload) => {
    void handleJoin(io, socket, userService, roomService, messageService, payload);
  });

  socket.on('user:update-profile', (payload) => {
    void handleUpdateProfile(io, socket, userService, payload);
  });

  socket.on('user:update-status-text', (payload) => {
    void handleUpdateStatusText(io, socket, userService, payload);
  });

  socket.on('user:update-theme', (payload) => {
    void handleUpdateTheme(socket, userService, payload);
  });

  socket.on('user:visibility', (payload) => {
    void handleVisibility(io, socket, userService, roomService, messageService, payload);
  });

  socket.on('user:change-password', (payload) => {
    void handleChangePassword(socket, userService, payload);
  });

  socket.on('user:regenerate-recovery-file', () => {
    void handleRegenerateRecoveryFile(socket, userService);
  });

  socket.on('user:list-sessions', () => {
    void handleListSessions(socket, userService);
  });

  socket.on('user:revoke-session', (payload) => {
    void handleRevokeSession(socket, userService, payload);
  });

  socket.on('disconnect', () => {
    void handleDisconnect(io, socket, userService);
  });
}

async function handleJoin(
  io: AppServer,
  socket: AppSocket,
  userService: UserService,
  roomService: RoomService,
  messageService: MessageService,
  payload: unknown,
): Promise<void> {
  try {
    const input = joinPayloadSchema.parse(payload);

    if (input.mode === 'register') {
      const { user, sessionId, sessionToken, recoveryFile } = await userService.registerAccount({
        nickname: input.nickname,
        avatar: input.avatar,
        password: input.password,
        socketId: socket.id,
        userAgent: socket.handshake.headers['user-agent'] ?? '',
      });

      socket.data.userId = user.id;
      socket.data.authMethod = 'password';
      socket.data.sessionId = sessionId;
      socket.emit('user:registered', {
        user: userService.toPublicUser(user),
        sessionToken,
        recoveryFile: recoveryFile.toString('base64'),
        authMethod: 'password',
      });
      socket.broadcast.emit('user:online', { userId: user.id, nickname: user.nickname, avatar: user.avatar });
      await deliverPendingMessages(io, roomService, messageService, user.id);
      return;
    }

    const resumed = await userService.resumeSession(input.userId, input.sessionToken, socket.id);
    if (!resumed) {
      socket.emit('error', { message: 'Sessão inválida ou expirada. Faça login novamente.' });
      return;
    }

    const { user, authMethod, sessionId } = resumed;
    socket.data.userId = user.id;
    socket.data.authMethod = authMethod;
    socket.data.sessionId = sessionId;
    socket.emit('user:resumed', { user: userService.toPublicUser(user), authMethod });
    socket.broadcast.emit('user:online', { userId: user.id, nickname: user.nickname, avatar: user.avatar });
    await deliverPendingMessages(io, roomService, messageService, user.id);
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function deliverPendingMessages(
  io: AppServer,
  roomService: RoomService,
  messageService: MessageService,
  userId: string,
): Promise<void> {
  const rooms = await roomService.getVisibleRoomsForUser(userId);

  for (const room of rooms) {
    const delivered = await messageService.markPendingMessagesDelivered(room.id, userId);
    for (const message of delivered) {
      const view = await messageService.toView(message);
      io.to(room.id).emit('message:updated', view);
    }
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
    const result = await userService.updateProfile(userId, { nickname, avatar });

    if (!result) {
      socket.emit('error', { message: 'Usuário não encontrado.' });
      return;
    }

    io.emit('user:profile-updated', {
      userId: result.user.id,
      nickname: result.user.nickname,
      avatar: result.user.avatar,
      statusText: result.user.statusText,
    });
    socket.emit('user:profile-updated-success', {
      user: userService.toPublicUser(result.user),
      recoveryFile: result.recoveryFile ? result.recoveryFile.toString('base64') : null,
    });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleUpdateStatusText(
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
    const { statusText } = updateStatusTextPayloadSchema.parse(payload);
    const updated = await userService.updateStatusText(userId, statusText);

    if (!updated) {
      socket.emit('error', { message: 'Usuário não encontrado.' });
      return;
    }

    io.emit('user:profile-updated', {
      userId: updated.id,
      nickname: updated.nickname,
      avatar: updated.avatar,
      statusText: updated.statusText,
    });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleUpdateTheme(socket: AppSocket, userService: UserService, payload: unknown): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  try {
    const theme = userThemeSchema.parse(payload);
    await userService.updateTheme(userId, theme);
  } catch {
    return;
  }
}

async function handleVisibility(
  io: AppServer,
  socket: AppSocket,
  userService: UserService,
  roomService: RoomService,
  messageService: MessageService,
  payload: unknown,
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  try {
    const { visible } = visibilityPayloadSchema.parse(payload);
    const updated = await userService.setStatus(userId, visible ? 'online' : 'offline');
    if (!updated) {
      return;
    }

    if (visible) {
      socket.broadcast.emit('user:online', {
        userId: updated.id,
        nickname: updated.nickname,
        avatar: updated.avatar,
      });
      await deliverPendingMessages(io, roomService, messageService, updated.id);
    } else {
      socket.broadcast.emit('user:offline', {
        userId: updated.id,
        user: { id: updated.id, status: updated.status, lastSeen: updated.lastSeen },
      });
    }
  } catch {
    return;
  }
}

async function handleChangePassword(socket: AppSocket, userService: UserService, payload: unknown): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { currentPassword, newPassword } = changePasswordPayloadSchema.parse(payload);
    const authMethod = socket.data.authMethod ?? 'password';
    const { recoveryFile } = await userService.changePassword(userId, currentPassword, newPassword, authMethod);

    delete socket.data.userId;
    delete socket.data.authMethod;
    delete socket.data.sessionId;
    socket.emit('user:password-changed', { recoveryFile: recoveryFile.toString('base64') });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleRegenerateRecoveryFile(socket: AppSocket, userService: UserService): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { recoveryFile } = await userService.regenerateRecoveryFile(userId);

    socket.emit('user:recovery-file-regenerated', { recoveryFile: recoveryFile.toString('base64') });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleListSessions(socket: AppSocket, userService: UserService): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  const sessions = await userService.listSessions(userId);
  socket.emit('user:sessions', {
    sessions: sessions.map((session) => ({
      id: session.id,
      authMethod: session.authMethod,
      device: describeDevice(session.userAgent),
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      isCurrent: session.id === socket.data.sessionId,
    })),
  });
}

async function handleRevokeSession(socket: AppSocket, userService: UserService, payload: unknown): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { sessionId } = revokeSessionPayloadSchema.parse(payload);
    await userService.revokeSession(userId, sessionId);
    await handleListSessions(socket, userService);

    if (sessionId === socket.data.sessionId) {
      delete socket.data.userId;
      delete socket.data.authMethod;
      delete socket.data.sessionId;
    }
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
