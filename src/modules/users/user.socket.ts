import { z } from 'zod';
import { getClientIp } from '../../config/client-ip.js';
import { errorPayloadSchema } from '../../docs/common-schemas.js';
import { registerClientEvents, registerServerEvents } from '../../docs/socket-registry.js';
import { AppError, errorPayload } from '../../lib/app-error.js';
import { SUPPORTED_LOCALES } from '../../lib/locale.js';
import type { AppServer, AppSocket } from '../../sockets/events.js';
import { exceedsLookupLimit, lookupTooLargePayload } from '../../sockets/id-lookup.js';
import { extractErrorPayload } from '../../sockets/socket-errors.js';
import { runSocketHandler } from '../../sockets/socket-handler.js';
import { bindSocketSession, clearSocketSession, requireSocketUserId } from '../../sockets/socket-session.js';
import { findSocketsBoundToUser, hasVisibleUserSocket, userRoom } from '../../sockets/user-sockets.js';
import { emitMessageUpdate, type MessageService } from '../messages/index.js';
import type { RoomService } from '../rooms/index.js';
import { authSaltSchema, authVersionOf, clientSecretSchema } from './user.credentials.js';
import { describeDevice } from './user.device.js';
import { getPublicKeysPayloadSchema, publishE2eKeysPayloadSchema, wrappedPrivateKeySchema } from './user.e2e-keys.js';
import type { LoginRateLimiter } from './user.login-rate-limiter.js';
import {
  type AuthMethod,
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
  PASSWORD_MIN_LENGTH,
  STATUS_TEXT_MAX_LENGTH,
  userChatSettingsSchema,
  userThemeSchema,
} from './user.model.js';
import type { UserService } from './user.service.js';
import type { RevokedSession } from './user.session-revocations.js';

export interface UserSocketDeps {
  userService: UserService;
  roomService: RoomService;
  messageService: MessageService;
  loginRateLimiter: LoginRateLimiter;
  onSessionReleased?: (context: { socket: AppSocket; userId: string }) => void;
}

async function contactRooms(deps: UserSocketDeps, userId: string): Promise<string[]> {
  const contactIds = await deps.roomService.getContactIds(userId);
  return contactIds.map(userRoom);
}

const joinPayloadSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('register'),
    nickname: z.string().trim().min(NICKNAME_MIN_LENGTH).max(NICKNAME_MAX_LENGTH),
    avatar: z.number().int().min(0),
    password: z.string().min(PASSWORD_MIN_LENGTH),
    authSalt: authSaltSchema.optional(),
    recoveryVerifier: clientSecretSchema.optional(),
  }),
  z.object({
    mode: z.literal('resume'),
    userId: z.string().trim().min(1),
    sessionToken: z.string().trim().min(1),
  }),
]);

const currentPasswordSchema = z.string().optional().openapi({
  description: 'Senha atual. Obrigatória para trocar o nickname, regenerar o arquivo de recuperação e trocar a senha',
});

const updateProfilePayloadSchema = z.object({
  nickname: z.string().trim().min(NICKNAME_MIN_LENGTH).max(NICKNAME_MAX_LENGTH),
  avatar: z.number().int().min(0),
  currentPassword: currentPasswordSchema,
});

const regenerateRecoveryFilePayloadSchema = z.object({
  currentPassword: currentPasswordSchema,
  recoveryVerifier: clientSecretSchema.optional(),
  encryptedPrivateKeyByRecovery: wrappedPrivateKeySchema.optional(),
});

const updateStatusTextPayloadSchema = z.object({
  statusText: z.string().max(STATUS_TEXT_MAX_LENGTH),
});

const visibilityPayloadSchema = z.object({
  visible: z.boolean(),
});

const changePasswordPayloadSchema = z.object({
  currentPassword: currentPasswordSchema,
  newPassword: z.string().min(PASSWORD_MIN_LENGTH),
  newAuthSalt: authSaltSchema.optional(),
  encryptedPrivateKeyByPassword: wrappedPrivateKeySchema.optional(),
  recoveryVerifier: clientSecretSchema.optional(),
  encryptedPrivateKeyByRecovery: wrappedPrivateKeySchema.optional(),
});

const upgradeCredentialsPayloadSchema = z.object({
  currentPassword: z.string().min(1),
  newAuthSalt: authSaltSchema,
  newAuthKey: clientSecretSchema,
  encryptedPrivateKeyByPassword: wrappedPrivateKeySchema,
  recoveryVerifier: clientSecretSchema,
  encryptedPrivateKeyByRecovery: wrappedPrivateKeySchema,
});

const credentialsUpgradedPayloadSchema = z.object({
  authVersion: z.literal(2),
});

const revokeSessionPayloadSchema = z.object({
  sessionId: z.string().trim().min(1),
});

const setLocalePayloadSchema = z.object({
  locale: z.enum(SUPPORTED_LOCALES),
});

const authFailedPayloadSchema = errorPayloadSchema.extend({
  mode: z.enum(['register', 'resume']),
  reason: z.enum(['invalid', 'temporary']),
});

const errorEventPayloadSchema = errorPayloadSchema.extend({
  clientTempId: z.string().optional().openapi({ description: 'Presente quando o erro se refere a um message:send que trouxe clientTempId' }),
  event: z.string().optional().openapi({ description: 'Evento de origem, presente nos erros das consultas de chaves E2EE, de e2e:publish-keys e de user:upgrade-credentials' }),
});

registerClientEvents('users', {
  'user:join': joinPayloadSchema,
  'user:update-profile': updateProfilePayloadSchema,
  'user:update-status-text': updateStatusTextPayloadSchema,
  'user:update-theme': userThemeSchema,
  'user:update-chat-settings': userChatSettingsSchema,
  'user:visibility': visibilityPayloadSchema,
  'user:set-locale': setLocalePayloadSchema,
  'user:change-password': changePasswordPayloadSchema,
  'user:regenerate-recovery-file': regenerateRecoveryFilePayloadSchema,
  'user:upgrade-credentials': upgradeCredentialsPayloadSchema,
  'user:logout': null,
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
  'user:credentials-upgraded',
  'user:sessions',
  'user:session-revoked',
  'user:chat-settings-updated',
  'e2e:public-keys',
  'e2e:my-keys',
  'error',
], {
  'user:auth-failed': authFailedPayloadSchema,
  'user:credentials-upgraded': credentialsUpgradedPayloadSchema,
  error: errorEventPayloadSchema,
});

export function registerUserSocketHandlers(io: AppServer, socket: AppSocket, deps: UserSocketDeps): void {
  socket.on('user:join', (payload) => {
    runSocketHandler(socket, 'user:join', () => handleJoin(io, socket, deps, payload));
  });

  socket.on('user:update-profile', (payload) => {
    runSocketHandler(socket, 'user:update-profile', () => handleUpdateProfile(io, socket, deps, payload));
  });

  socket.on('user:update-status-text', (payload) => {
    runSocketHandler(socket, 'user:update-status-text', () => handleUpdateStatusText(io, socket, deps, payload));
  });

  socket.on('user:update-theme', (payload) => {
    runSocketHandler(socket, 'user:update-theme', () => handleUpdateTheme(socket, deps, payload));
  });

  socket.on('user:update-chat-settings', (payload) => {
    runSocketHandler(socket, 'user:update-chat-settings', () => handleUpdateChatSettings(socket, deps, payload));
  });

  socket.on('user:visibility', (payload, ack) => {
    ack?.();
    runSocketHandler(socket, 'user:visibility', () => handleVisibility(io, socket, deps, payload));
  });

  socket.on('user:set-locale', (payload) => {
    runSocketHandler(socket, 'user:set-locale', () => {
      handleSetLocale(socket, payload);
    });
  });

  socket.on('user:change-password', (payload) => {
    runSocketHandler(socket, 'user:change-password', () => handleChangePassword(io, socket, deps, payload));
  });

  socket.on('user:regenerate-recovery-file', (payload) => {
    runSocketHandler(socket, 'user:regenerate-recovery-file', () => handleRegenerateRecoveryFile(io, socket, deps, payload));
  });

  socket.on('user:upgrade-credentials', (payload) => {
    runSocketHandler(socket, 'user:upgrade-credentials', () => handleUpgradeCredentials(socket, deps, payload));
  });

  socket.on('user:logout', () => {
    runSocketHandler(socket, 'user:logout', () => handleLogout(io, socket, deps));
  });

  socket.on('user:list-sessions', () => {
    runSocketHandler(socket, 'user:list-sessions', () => handleListSessions(socket, deps));
  });

  socket.on('user:revoke-session', (payload) => {
    runSocketHandler(socket, 'user:revoke-session', () => handleRevokeSession(io, socket, deps, payload));
  });

  socket.on('e2e:publish-keys', (payload) => {
    runSocketHandler(socket, 'e2e:publish-keys', () => handlePublishE2eKeys(socket, deps, payload));
  });

  socket.on('e2e:get-public-keys', (payload) => {
    runSocketHandler(socket, 'e2e:get-public-keys', () => handleGetPublicKeys(socket, deps, payload));
  });

  socket.on('e2e:get-my-keys', () => {
    runSocketHandler(socket, 'e2e:get-my-keys', () => handleGetMyKeys(socket, deps));
  });

  socket.on('disconnect', () => {
    deps.loginRateLimiter.forgetSocket(socket.id);
    runSocketHandler(socket, 'disconnect', () => handleDisconnect(io, socket, deps));
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
      const ip = getClientIp(socket.request);
      if (loginRateLimiter.isBlockedForRegistration(ip)) {
        socket.emit('user:auth-failed', {
          mode: 'register',
          reason: 'invalid',
          ...errorPayload('rateLimit.registrations'),
        });
        return;
      }
      loginRateLimiter.registerAttemptForRegistration(ip);

      const { user, sessionId, sessionToken, recoveryFile, recoveryToken } = await userService.registerAccount({
        nickname: input.nickname,
        avatar: input.avatar,
        password: input.password,
        authSalt: input.authSalt,
        recoveryVerifier: input.recoveryVerifier,
        userAgent: socket.handshake.headers['user-agent'] ?? '',
      });

      if (!(await bindActiveSocketSession(socket, deps, { userId: user.id, authMethod: 'password', sessionId }))) {
        return;
      }
      socket.emit('user:registered', {
        user: userService.toPublicUser(user),
        sessionToken,
        recoveryFile: recoveryFile ? recoveryFile.toString('base64') : null,
        recoveryToken,
        authMethod: 'password',
      });
      socket.to(await contactRooms(deps, user.id)).emit('user:online', { userId: user.id, nickname: user.nickname, avatar: user.avatar });
      await deliverPendingMessages(io, deps, user.id);
      return;
    }

    if (!loginRateLimiter.reserveResume(socket.id, getClientIp(socket.request))) {
      socket.emit('user:auth-failed', {
        mode: 'resume',
        reason: 'temporary',
        ...errorPayload('rateLimit.resumeAttempts'),
      });
      return;
    }

    const resumed = await userService.resumeSession(input.userId, input.sessionToken);
    if (!resumed) {
      socket.emit('user:auth-failed', {
        mode: 'resume',
        reason: 'invalid',
        ...errorPayload('auth.sessionExpired'),
      });
      return;
    }

    const { user, authMethod, sessionId } = resumed;
    if (!(await bindActiveSocketSession(socket, deps, { userId: user.id, authMethod, sessionId }))) {
      return;
    }
    socket.emit('user:resumed', { user: userService.toPublicUser(user), authMethod });
    socket.to(await contactRooms(deps, user.id)).emit('user:online', { userId: user.id, nickname: user.nickname, avatar: user.avatar });
    await deliverPendingMessages(io, deps, user.id);
  } catch (error) {
    const isPayloadError = error instanceof z.ZodError;
    socket.emit('user:auth-failed', {
      mode: joinMode,
      reason: joinMode === 'resume' && !isPayloadError ? 'temporary' : 'invalid',
      ...extractErrorPayload(error),
    });
  }
}

async function bindActiveSocketSession(
  socket: AppSocket,
  deps: UserSocketDeps,
  binding: { userId: string; authMethod: AuthMethod; sessionId: string },
): Promise<boolean> {
  if (!(await bindSocketSession(socket, binding))) {
    return false;
  }

  if (await deps.userService.isSessionActive(binding.userId, binding.sessionId)) {
    return true;
  }

  await clearSocketSession(socket);
  socket.emit('user:session-revoked');
  socket.disconnect(true);
  return false;
}

async function requireActiveSocketSession(socket: AppSocket, deps: UserSocketDeps): Promise<{ userId: string; sessionId: string } | null> {
  const { userId, sessionId } = socket.data;
  if (!userId || !sessionId) {
    socket.emit('error', errorPayload('auth.unauthenticated'));
    return null;
  }

  if (await deps.userService.isSessionActive(userId, sessionId)) {
    return { userId, sessionId };
  }

  socket.emit('user:session-revoked');
  socket.disconnect(true);
  return null;
}

async function withPasswordAttempt<T>(deps: UserSocketDeps, userId: string, currentPassword: string | undefined, action: () => Promise<T>): Promise<T> {
  const verifiesPassword = typeof currentPassword === 'string' && currentPassword.length > 0;
  if (verifiesPassword && !deps.loginRateLimiter.reserveReauthAttempt(userId)) {
    throw AppError.of('rateLimit.passwordAttempts');
  }

  try {
    const result = await action();
    if (verifiesPassword) {
      deps.loginRateLimiter.releaseReauthAttempt(userId);
    }
    return result;
  } catch (error) {
    const isWrongPassword = error instanceof AppError && error.code === 'user.currentPasswordIncorrect';
    if (verifiesPassword && !isWrongPassword) {
      deps.loginRateLimiter.releaseReauthAttempt(userId);
    }
    throw error;
  }
}

async function deliverPendingMessages(io: AppServer, deps: UserSocketDeps, userId: string): Promise<void> {
  const { roomService, messageService } = deps;
  const rooms = await roomService.getVisibleRoomsForUser(userId);
  const deliveredByRoom = await messageService.markPendingMessagesDeliveredInRooms(
    rooms.map((room) => ({ roomId: room.id, after: roomService.getVisibilityCutoff(room, userId) })),
    userId,
  );

  for (const room of rooms) {
    const delivered = deliveredByRoom.get(room.id);
    if (!delivered) {
      continue;
    }

    const views = await messageService.toViews(delivered);
    for (const view of views) {
      emitMessageUpdate(io, roomService, room, view);
    }
  }
}

async function handleUpdateProfile(io: AppServer, socket: AppSocket, deps: UserSocketDeps, payload: unknown): Promise<void> {
  if (!requireSocketUserId(socket)) {
    return;
  }

  try {
    const { nickname, avatar, currentPassword } = updateProfilePayloadSchema.parse(payload);
    const session = await requireActiveSocketSession(socket, deps);
    if (!session) {
      return;
    }

    const result = await withPasswordAttempt(deps, session.userId, currentPassword, () =>
      deps.userService.updateProfile(session.userId, { nickname, avatar, currentPassword }, session.sessionId),
    );

    if (!result) {
      socket.emit('error', errorPayload('user.notFound'));
      return;
    }

    if (result.revokedOtherSessions) {
      revokeUserSockets(io, session.userId, socket, (target) => target.data.sessionId !== session.sessionId);
    }

    io.to(await contactRooms(deps, result.user.id)).emit('user:profile-updated', {
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
    socket.emit('error', extractErrorPayload(error));
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
      socket.emit('error', errorPayload('user.notFound'));
      return;
    }

    io.to(await contactRooms(deps, updated.id)).emit('user:profile-updated', {
      userId: updated.id,
      nickname: updated.nickname,
      avatar: updated.avatar,
      statusText: updated.statusText,
    });
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
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

function handleSetLocale(socket: AppSocket, payload: unknown): void {
  const parsed = setLocalePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return;
  }

  socket.data.locale = parsed.data.locale;
}

async function releaseSocketUser(io: AppServer, socket: AppSocket, deps: UserSocketDeps): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  const wasVisible = socket.data.hidden !== true;
  deps.onSessionReleased?.({ socket, userId });
  await clearSocketSession(socket);
  if (wasVisible) {
    await markOfflineIfNoVisibleSocket(io, deps, userId);
  }
}

async function markOfflineIfNoVisibleSocket(io: AppServer, deps: UserSocketDeps, userId: string): Promise<void> {
  if (hasVisibleUserSocket(io, userId)) {
    return;
  }

  const updated = await deps.userService.setStatus(userId, 'offline');
  if (!updated) {
    return;
  }

  io.to(await contactRooms(deps, updated.id)).emit('user:offline', {
    userId: updated.id,
    user: { id: updated.id, status: updated.status, lastSeen: updated.lastSeen },
  });
}

function revokeUserSockets(io: AppServer, userId: string, requester: AppSocket | null, shouldRevoke: (target: AppSocket) => boolean): void {
  for (const target of findSocketsBoundToUser(io, userId)) {
    if (target.id === requester?.id || !shouldRevoke(target)) {
      continue;
    }
    target.emit('user:session-revoked');
    target.disconnect(true);
  }
}

export function disconnectRevokedSession(io: AppServer, revoked: RevokedSession): void {
  revokeUserSockets(io, revoked.userId, null, (target) => target.data.sessionId === revoked.sessionId);
}

async function handleLogout(io: AppServer, socket: AppSocket, deps: UserSocketDeps): Promise<void> {
  const { userId, sessionId } = socket.data;
  if (!userId || !sessionId) {
    return;
  }

  await deps.userService.revokeSession(userId, sessionId);
  revokeUserSockets(io, userId, socket, (target) => target.data.sessionId === sessionId);
  await releaseSocketUser(io, socket, deps);
}

async function handleUpdateChatSettings(socket: AppSocket, deps: UserSocketDeps, payload: unknown): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  const parsed = userChatSettingsSchema.safeParse(payload);
  if (!parsed.success) {
    return;
  }

  await deps.userService.updateChatSettings(userId, parsed.data);
  socket.to(userRoom(userId)).emit('user:chat-settings-updated', { chatSettings: parsed.data });
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
  socket.data.hidden = !visible;

  if (!visible && hasVisibleUserSocket(io, userId)) {
    return;
  }

  const updated = await deps.userService.setStatus(userId, visible ? 'online' : 'offline');
  if (!updated) {
    return;
  }

  const presenceRooms = await contactRooms(deps, updated.id);
  if (visible) {
    socket.to(presenceRooms).emit('user:online', {
      userId: updated.id,
      nickname: updated.nickname,
      avatar: updated.avatar,
    });
    await deliverPendingMessages(io, deps, updated.id);
  } else {
    socket.to(presenceRooms).emit('user:offline', {
      userId: updated.id,
      user: { id: updated.id, status: updated.status, lastSeen: updated.lastSeen },
    });
  }
}

async function handleChangePassword(io: AppServer, socket: AppSocket, deps: UserSocketDeps, payload: unknown): Promise<void> {
  if (!requireSocketUserId(socket)) {
    return;
  }

  try {
    const { currentPassword, newPassword, ...credentials } = changePasswordPayloadSchema.parse(payload);
    const session = await requireActiveSocketSession(socket, deps);
    if (!session) {
      return;
    }

    const { userId, sessionId } = session;
    const { recoveryFile, recoveryToken } = await withPasswordAttempt(deps, userId, currentPassword, () =>
      deps.userService.changePassword(userId, { currentPassword, newPassword, sessionId, ...credentials }),
    );

    revokeUserSockets(io, userId, socket, () => true);
    await releaseSocketUser(io, socket, deps);
    socket.emit('user:password-changed', { recoveryFile: recoveryFile ? recoveryFile.toString('base64') : null, recoveryToken });
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}

async function handleRegenerateRecoveryFile(io: AppServer, socket: AppSocket, deps: UserSocketDeps, payload: unknown): Promise<void> {
  if (!requireSocketUserId(socket)) {
    return;
  }

  try {
    const { currentPassword, ...recovery } = regenerateRecoveryFilePayloadSchema.parse(payload ?? {});
    const session = await requireActiveSocketSession(socket, deps);
    if (!session) {
      return;
    }

    const { userId, sessionId } = session;
    const { recoveryFile, recoveryToken } = await withPasswordAttempt(deps, userId, currentPassword, () =>
      deps.userService.regenerateRecoveryFile(userId, currentPassword, sessionId, recovery),
    );

    revokeUserSockets(io, userId, socket, (target) => target.data.sessionId !== sessionId);

    socket.emit('user:recovery-file-regenerated', { recoveryFile: recoveryFile ? recoveryFile.toString('base64') : null, recoveryToken });
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}

async function handleUpgradeCredentials(socket: AppSocket, deps: UserSocketDeps, payload: unknown): Promise<void> {
  if (!requireSocketUserId(socket)) {
    return;
  }

  try {
    const input = upgradeCredentialsPayloadSchema.parse(payload);
    const session = await requireActiveSocketSession(socket, deps);
    if (!session) {
      return;
    }

    await withPasswordAttempt(deps, session.userId, input.currentPassword, () => deps.userService.upgradeCredentials(session.userId, input));
    socket.emit('user:credentials-upgraded', { authVersion: 2 });
  } catch (error) {
    socket.emit('error', { ...extractErrorPayload(error), event: 'user:upgrade-credentials' });
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

    revokeUserSockets(io, userId, socket, (target) => target.data.sessionId === sessionId);
    if (sessionId === socket.data.sessionId) {
      await releaseSocketUser(io, socket, deps);
    }
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}

async function handleDisconnect(io: AppServer, socket: AppSocket, deps: UserSocketDeps): Promise<void> {
  const userId = socket.data.userId;
  if (!userId || socket.data.hidden === true) {
    return;
  }

  await markOfflineIfNoVisibleSocket(io, deps, userId);
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
    socket.emit('error', { ...extractErrorPayload(error), event: 'e2e:publish-keys' });
  }
}

async function handleGetPublicKeys(socket: AppSocket, deps: UserSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  if (exceedsLookupLimit(payload, 'userIds')) {
    socket.emit('error', lookupTooLargePayload('e2e:get-public-keys'));
    return;
  }

  try {
    const { userIds } = getPublicKeysPayloadSchema.parse(payload);
    const keys = await deps.userService.getPublicKeys(userIds);
    socket.emit('e2e:public-keys', { keys });
  } catch (error) {
    socket.emit('error', { ...extractErrorPayload(error), event: 'e2e:get-public-keys' });
  }
}

async function handleGetMyKeys(socket: AppSocket, deps: UserSocketDeps): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  const user = await deps.userService.getUser(userId);
  if (!user) {
    socket.emit('error', errorPayload('user.notFound'));
    return;
  }

  socket.emit('e2e:my-keys', {
    publicKey: user.e2ePublicKey ?? null,
    encryptedPrivateKeyByPassword: user.e2eEncryptedPrivateKeyByPassword ?? null,
    encryptedPrivateKeyByRecovery: user.e2eEncryptedPrivateKeyByRecovery ?? null,
    authVersion: authVersionOf(user),
  });
}
