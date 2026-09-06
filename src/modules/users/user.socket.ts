import { z } from 'zod';
import { registerClientEvents, registerServerEvents } from '../../docs/socket-registry.js';
import type { AppServer, AppSocket } from '../../sockets/events.js';
import { extractErrorMessage } from '../../sockets/socket-errors.js';
import { clearSocketSession, requireSocketUserId } from '../../sockets/socket-session.js';
import type { MessageService } from '../messages/index.js';
import type { RoomService } from '../rooms/index.js';
import { describeDevice } from './user.device.js';
import { getPublicKeysPayloadSchema, publishE2eKeysPayloadSchema } from './user.e2e-keys.js';
import type { LoginRateLimiter } from './user.login-rate-limiter.js';
import {
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
  PASSWORD_MIN_LENGTH,
  STATUS_TEXT_MAX_LENGTH,
  userThemeSchema,
} from './user.model.js';
import type { UserService } from './user.service.js';

export interface UserSocketDeps {
  userService: UserService;
  roomService: RoomService;
  messageService: MessageService;
  loginRateLimiter: LoginRateLimiter;
}

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

registerClientEvents('users', {
  'user:join': joinPayloadSchema,
  'user:update-profile': updateProfilePayloadSchema,
  'user:update-status-text': updateStatusTextPayloadSchema,
  'user:update-theme': userThemeSchema,
  'user:visibility': visibilityPayloadSchema,
  'user:change-password': changePasswordPayloadSchema,
  'user:regenerate-recovery-file': null,
  'user:list-sessions': null,
  'user:revoke-session': revokeSessionPayloadSchema,
  'e2e:publish-keys': publishE2eKeysPayloadSchema,
  'e2e:get-public-keys': getPublicKeysPayloadSchema,
  'e2e:get-my-keys': null,
});

registerServerEvents('users', [
  'user:registered',
  'user:resumed',
  'user:auth-failed',
  'user:online',
  'user:offline',
  'user:profile-updated',
  'user:profile-updated-success',
  'user:password-changed',
  'user:recovery-file-regenerated',
  'user:sessions',
  'user:session-revoked',
  'e2e:public-keys',
  'e2e:my-keys',
  'error',
]);

export function registerUserSocketHandlers(io: AppServer, socket: AppSocket, deps: UserSocketDeps): void {
  socket.on('user:join', (payload) => {
    void handleJoin(io, socket, deps, payload);
  });

  socket.on('user:update-profile', (payload) => {
    void handleUpdateProfile(io, socket, deps, payload);
  });

  socket.on('user:update-status-text', (payload) => {
    void handleUpdateStatusText(io, socket, deps, payload);
  });

  socket.on('user:update-theme', (payload) => {
    void handleUpdateTheme(socket, deps, payload);
  });

  socket.on('user:visibility', (payload, ack) => {
    ack?.();
    void handleVisibility(io, socket, deps, payload);
  });

  socket.on('user:change-password', (payload) => {
    void handleChangePassword(socket, deps, payload);
  });

  socket.on('user:regenerate-recovery-file', () => {
    void handleRegenerateRecoveryFile(socket, deps);
  });

  socket.on('user:list-sessions', () => {
    void handleListSessions(socket, deps);
  });

  socket.on('user:revoke-session', (payload) => {
    void handleRevokeSession(io, socket, deps, payload);
  });

  socket.on('e2e:publish-keys', (payload) => {
    void handlePublishE2eKeys(socket, deps, payload);
  });

  socket.on('e2e:get-public-keys', (payload) => {
    void handleGetPublicKeys(socket, deps, payload);
  });

  socket.on('e2e:get-my-keys', () => {
    void handleGetMyKeys(socket, deps);
  });

  socket.on('disconnect', () => {
    void handleDisconnect(io, socket, deps);
  });
}

function readJoinMode(payload: unknown): 'register' | 'resume' {
  const mode = typeof payload === 'object' && payload !== null ? (payload as { mode?: unknown }).mode : undefined;
  return mode === 'register' ? 'register' : 'resume';
}

async function handleJoin(io: AppServer, socket: AppSocket, deps: UserSocketDeps, payload: unknown): Promise<void> {
  const { userService, loginRateLimiter } = deps;
  const joinMode = readJoinMode(payload);

  try {
    const input = joinPayloadSchema.parse(payload);

    if (input.mode === 'register') {
      const ip = socket.handshake.address;
      if (loginRateLimiter.isBlockedForRegistration(ip)) {
        socket.emit('user:auth-failed', {
          mode: 'register',
          reason: 'invalid',
          message: 'Muitas contas criadas a partir deste endereço. Tente novamente mais tarde.',
        });
        return;
      }
      loginRateLimiter.registerAttemptForRegistration(ip);

      const { user, sessionId, sessionToken, recoveryFile, recoveryToken } = await userService.registerAccount({
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
        recoveryToken,
        authMethod: 'password',
      });
      socket.broadcast.emit('user:online', { userId: user.id, nickname: user.nickname, avatar: user.avatar });
      await deliverPendingMessages(io, deps, user.id);
      return;
    }

    const resumed = await userService.resumeSession(input.userId, input.sessionToken, socket.id);
    if (!resumed) {
      socket.emit('user:auth-failed', {
        mode: 'resume',
        reason: 'invalid',
        message: 'Sessão inválida ou expirada. Faça login novamente.',
      });
      return;
    }

    const { user, authMethod, sessionId } = resumed;
    socket.data.userId = user.id;
    socket.data.authMethod = authMethod;
    socket.data.sessionId = sessionId;
    socket.emit('user:resumed', { user: userService.toPublicUser(user), authMethod });
    socket.broadcast.emit('user:online', { userId: user.id, nickname: user.nickname, avatar: user.avatar });
    await deliverPendingMessages(io, deps, user.id);
  } catch (error) {
    const isPayloadError = error instanceof z.ZodError;
    socket.emit('user:auth-failed', {
      mode: joinMode,
      reason: joinMode === 'resume' && !isPayloadError ? 'temporary' : 'invalid',
      message: extractErrorMessage(error),
    });
  }
}

async function deliverPendingMessages(io: AppServer, deps: UserSocketDeps, userId: string): Promise<void> {
  const { roomService, messageService } = deps;
  const rooms = await roomService.getVisibleRoomsForUser(userId);
  const deliveredByRoom = await messageService.markPendingMessagesDeliveredInRooms(
    rooms.map((room) => room.id),
    userId,
  );

  for (const room of rooms) {
    const delivered = deliveredByRoom.get(room.id);
    if (!delivered) {
      continue;
    }

    const views = await messageService.toViews(delivered);
    for (const view of views) {
      io.to(room.id).emit('message:updated', view);
    }
  }
}

async function handleUpdateProfile(io: AppServer, socket: AppSocket, deps: UserSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  try {
    const { nickname, avatar } = updateProfilePayloadSchema.parse(payload);
    const result = await deps.userService.updateProfile(userId, { nickname, avatar });

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
      user: deps.userService.toPublicUser(result.user),
      recoveryFile: result.recoveryFile ? result.recoveryFile.toString('base64') : null,
      recoveryToken: result.recoveryToken,
    });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleUpdateStatusText(io: AppServer, socket: AppSocket, deps: UserSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  try {
    const { statusText } = updateStatusTextPayloadSchema.parse(payload);
    const updated = await deps.userService.updateStatusText(userId, statusText);

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

async function handleUpdateTheme(socket: AppSocket, deps: UserSocketDeps, payload: unknown): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  const parsed = userThemeSchema.safeParse(payload);
  if (!parsed.success) {
    return;
  }

  await deps.userService.updateTheme(userId, parsed.data);
}

async function handleVisibility(io: AppServer, socket: AppSocket, deps: UserSocketDeps, payload: unknown): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  const parsed = visibilityPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return;
  }

  const { visible } = parsed.data;
  const updated = await deps.userService.setStatus(userId, visible ? 'online' : 'offline');
  if (!updated) {
    return;
  }

  if (visible) {
    socket.broadcast.emit('user:online', {
      userId: updated.id,
      nickname: updated.nickname,
      avatar: updated.avatar,
    });
    await deliverPendingMessages(io, deps, updated.id);
  } else {
    socket.broadcast.emit('user:offline', {
      userId: updated.id,
      user: { id: updated.id, status: updated.status, lastSeen: updated.lastSeen },
    });
  }
}

async function handleChangePassword(socket: AppSocket, deps: UserSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  try {
    const { currentPassword, newPassword } = changePasswordPayloadSchema.parse(payload);
    const authMethod = socket.data.authMethod ?? 'password';
    const { recoveryFile, recoveryToken } = await deps.userService.changePassword(userId, currentPassword, newPassword, authMethod);

    clearSocketSession(socket);
    socket.emit('user:password-changed', { recoveryFile: recoveryFile.toString('base64'), recoveryToken });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleRegenerateRecoveryFile(socket: AppSocket, deps: UserSocketDeps): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  try {
    const { recoveryFile, recoveryToken } = await deps.userService.regenerateRecoveryFile(userId);

    socket.emit('user:recovery-file-regenerated', { recoveryFile: recoveryFile.toString('base64'), recoveryToken });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleListSessions(socket: AppSocket, deps: UserSocketDeps): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  const sessions = await deps.userService.listSessions(userId);
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

async function handleRevokeSession(io: AppServer, socket: AppSocket, deps: UserSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  try {
    const { sessionId } = revokeSessionPayloadSchema.parse(payload);
    await deps.userService.revokeSession(userId, sessionId);
    await handleListSessions(socket, deps);

    if (sessionId === socket.data.sessionId) {
      clearSocketSession(socket);
    } else {
      disconnectRevokedSession(io, socket, userId, sessionId);
    }
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

function disconnectRevokedSession(io: AppServer, requester: AppSocket, userId: string, sessionId: string): void {
  for (const target of io.sockets.sockets.values()) {
    if (target.id === requester.id) {
      continue;
    }
    if (target.data.userId === userId && target.data.sessionId === sessionId) {
      target.emit('user:session-revoked');
      target.disconnect(true);
    }
  }
}

async function handleDisconnect(io: AppServer, socket: AppSocket, deps: UserSocketDeps): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  const updated = await deps.userService.setStatus(userId, 'offline');
  if (!updated) {
    return;
  }

  io.emit('user:offline', {
    userId: updated.id,
    user: { id: updated.id, status: updated.status, lastSeen: updated.lastSeen },
  });
}

async function handlePublishE2eKeys(socket: AppSocket, deps: UserSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  try {
    const input = publishE2eKeysPayloadSchema.parse(payload);
    await deps.userService.publishE2eKeys(userId, input);
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleGetPublicKeys(socket: AppSocket, deps: UserSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  try {
    const { userIds } = getPublicKeysPayloadSchema.parse(payload);
    const keys = await deps.userService.getPublicKeys(userIds);
    socket.emit('e2e:public-keys', { keys });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleGetMyKeys(socket: AppSocket, deps: UserSocketDeps): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  const user = await deps.userService.getUser(userId);
  if (!user) {
    socket.emit('error', { message: 'Usuário não encontrado.' });
    return;
  }

  socket.emit('e2e:my-keys', {
    publicKey: user.e2ePublicKey ?? null,
    encryptedPrivateKeyByPassword: user.e2eEncryptedPrivateKeyByPassword ?? null,
    encryptedPrivateKeyByRecovery: user.e2eEncryptedPrivateKeyByRecovery ?? null,
  });
}
