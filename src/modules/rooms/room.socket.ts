import { z } from 'zod';
import { registerClientEvents, registerServerEvents } from '../../docs/socket-registry.js';
import { errorPayload } from '../../lib/app-error.js';
import type { Locale } from '../../lib/locale.js';
import type { AppServer, AppSocket } from '../../sockets/events.js';
import { roomIdPayloadSchema } from '../../sockets/payloads.js';
import { extractErrorPayload } from '../../sockets/socket-errors.js';
import { runSocketHandler } from '../../sockets/socket-handler.js';
import { socketLocale } from '../../sockets/socket-locale.js';
import { exceedsLookupLimit, E2E_LOOKUP_MAX_ITEMS, lookupTooLargePayload } from '../../sockets/id-lookup.js';
import { requireSocketUserId } from '../../sockets/socket-session.js';
import { emitToUser, joinUserSocketsToRoom, removeUserSocketsFromRoom, userRoom } from '../../sockets/user-sockets.js';
import { INITIAL_MESSAGES_LIMIT, systemEvent, type MessageService, type MessageView } from '../messages/index.js';
import { NICKNAME_MAX_LENGTH, type UserService } from '../users/index.js';
import type { RoomKeyRepository } from './room.e2e.js';
import type { RoomActionRateLimiter } from './room.rate-limiter.js';
import type { RoomService } from './room.service.js';
import type { RoomRecord } from './room.types.js';

export type OnRoomCreatedHook = (context: { io: AppServer; room: RoomRecord; locale: Locale }) => void;
export type ShouldResetInsteadOfDeleteHook = (room: RoomRecord) => boolean;
export type OnRoomKeyPublishedHook = (context: { io: AppServer; room: RoomRecord }) => void;
export type CanReplaceRoomKeyHook = (room: RoomRecord, userId: string) => boolean;

export interface RoomSocketDeps {
  roomService: RoomService;
  userService: UserService;
  messageService: MessageService;
  roomKeyRepository: RoomKeyRepository;
  rateLimiter: RoomActionRateLimiter;
  onRoomCreated?: OnRoomCreatedHook;
  shouldResetInsteadOfDelete?: ShouldResetInsteadOfDeleteHook;
  onRoomKeyPublished?: OnRoomKeyPublishedHook;
  canReplaceRoomKey?: CanReplaceRoomKeyHook;
}

const ROOM_CODE_MIN_LENGTH = 8;
const ROOM_CODE_MAX_LENGTH = 12;
const ROOM_CODE_INPUT_MAX_LENGTH = 64;
const ROOM_NAME_MAX_LENGTH = 64;
const MAX_SEALED_KEY_LENGTH = 2000;

const createPrivateRoomPayloadSchema = z.object({
  targetNickname: z.string().trim().min(1).max(NICKNAME_MAX_LENGTH),
});

const createGroupRoomPayloadSchema = z.object({
  roomName: z.string().trim().min(1).max(ROOM_NAME_MAX_LENGTH),
});

const joinByCodePayloadSchema = z.object({
  roomCode: z.string().trim().min(1).max(ROOM_CODE_INPUT_MAX_LENGTH),
});

const blockPayloadSchema = z.object({
  roomId: z.string().trim().min(1),
  blockedUserId: z.string().trim().min(1),
});

const memberActionPayloadSchema = z.object({
  roomId: z.string().trim().min(1),
  userId: z.string().trim().min(1),
});

const publishRoomKeyPayloadSchema = z.object({
  roomId: z.string().trim().min(1),
  keys: z
    .array(
      z.object({
        userId: z.string().trim().min(1),
        sealedKey: z.string().trim().min(1).max(MAX_SEALED_KEY_LENGTH),
      }),
    )
    .min(1)
    .max(50),
});

const getRoomKeysPayloadSchema = z.object({
  roomIds: z.array(z.string().trim().min(1)).min(1).max(E2E_LOOKUP_MAX_ITEMS),
});

registerClientEvents('rooms', {
  'room:create-private': createPrivateRoomPayloadSchema,
  'room:create-group': createGroupRoomPayloadSchema,
  'room:join-by-code': joinByCodePayloadSchema,
  'room:join': roomIdPayloadSchema,
  'room:delete': roomIdPayloadSchema,
  'rooms:get': null,
  'group:leave': roomIdPayloadSchema,
  'group:remove-member': memberActionPayloadSchema,
  'group:promote-admin': memberActionPayloadSchema,
  'user:block': blockPayloadSchema,
  'user:unblock': blockPayloadSchema,
  'e2e:publish-room-key': publishRoomKeyPayloadSchema,
  'e2e:get-room-keys': getRoomKeysPayloadSchema,
  'e2e:request-room-key': roomIdPayloadSchema,
});

registerServerEvents('rooms', [
  'room:joined',
  'room:new',
  'room:created',
  'room:deleted',
  'rooms:list',
  'group:user-joined',
  'group:left',
  'group:user-left',
  'group:participants-updated',
  'user:blocked',
  'user:unblocked',
  'e2e:room-keys',
  'e2e:room-key',
  'e2e:key-request',
  'e2e:room-key-rejected',
]);

async function getInitialMessageViews(deps: RoomSocketDeps, room: RoomRecord, userId: string): Promise<MessageView[]> {
  const after = deps.roomService.getVisibilityCutoff(room, userId);
  const { messages } = await deps.messageService.getRoomMessagesPage(room.id, { after, limit: INITIAL_MESSAGES_LIMIT });
  return deps.messageService.toViews(messages);
}

export function registerRoomSocketHandlers(io: AppServer, socket: AppSocket, deps: RoomSocketDeps): void {
  socket.on('room:create-private', (payload) => {
    runSocketHandler(socket, 'room:create-private', () => handleCreatePrivateRoom(io, socket, deps, payload));
  });

  socket.on('room:create-group', (payload) => {
    runSocketHandler(socket, 'room:create-group', () => handleCreateGroupRoom(io, socket, deps, payload));
  });

  socket.on('rooms:get', () => {
    runSocketHandler(socket, 'rooms:get', () => handleRoomsGet(socket, deps));
  });

  socket.on('room:join-by-code', (payload) => {
    runSocketHandler(socket, 'room:join-by-code', () => handleJoinByCode(io, socket, deps, payload));
  });

  socket.on('room:join', (payload) => {
    runSocketHandler(socket, 'room:join', () => handleJoinRoom(socket, deps, payload));
  });

  socket.on('room:delete', (payload) => {
    runSocketHandler(socket, 'room:delete', () => handleDeleteRoom(io, socket, deps, payload));
  });

  socket.on('group:leave', (payload) => {
    runSocketHandler(socket, 'group:leave', () => handleLeaveGroup(io, socket, deps, payload));
  });

  socket.on('group:remove-member', (payload) => {
    runSocketHandler(socket, 'group:remove-member', () => handleRemoveMember(io, socket, deps, payload));
  });

  socket.on('group:promote-admin', (payload) => {
    runSocketHandler(socket, 'group:promote-admin', () => handlePromoteAdmin(io, socket, deps, payload));
  });

  socket.on('user:block', (payload) => {
    runSocketHandler(socket, 'user:block', () => handleBlockUser(io, socket, deps, payload));
  });

  socket.on('user:unblock', (payload) => {
    runSocketHandler(socket, 'user:unblock', () => handleUnblockUser(io, socket, deps, payload));
  });

  socket.on('e2e:publish-room-key', (payload) => {
    runSocketHandler(socket, 'e2e:publish-room-key', () => handlePublishRoomKey(io, socket, deps, payload));
  });

  socket.on('e2e:get-room-keys', (payload) => {
    runSocketHandler(socket, 'e2e:get-room-keys', () => handleGetRoomKeys(socket, deps, payload));
  });

  socket.on('e2e:request-room-key', (payload) => {
    runSocketHandler(socket, 'e2e:request-room-key', () => handleRequestRoomKey(socket, deps, payload));
  });
}

async function handleCreatePrivateRoom(io: AppServer, socket: AppSocket, deps: RoomSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  const { roomService, userService } = deps;

  try {
    const { targetNickname } = createPrivateRoomPayloadSchema.parse(payload);

    const targetUser = await userService.getUserByNickname(targetNickname);
    if (!targetUser) {
      socket.emit('error', errorPayload('user.notFound'));
      return;
    }

    if (targetUser.id === userId) {
      socket.emit('error', errorPayload('room.selfConversation'));
      return;
    }

    const existingRoom = await roomService.findPrivateRoomBetween(userId, targetUser.id);
    const room = await roomService.createPrivateRoom(userId, targetUser.id);
    await socket.join(room.id);
    await Promise.all([joinUserSocketsToRoom(io, userId, room.id), joinUserSocketsToRoom(io, targetUser.id, room.id)]);

    const messageViews = await getInitialMessageViews(deps, room, userId);

    const summaryForViewer = await roomService.buildSummary(room, userId);
    socket.emit('room:joined', { room: summaryForViewer, messages: messageViews });

    if (!existingRoom) {
      deps.onRoomCreated?.({ io, room, locale: socketLocale(socket) });
    }
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}

async function handleCreateGroupRoom(io: AppServer, socket: AppSocket, deps: RoomSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  const { roomService, userService, messageService } = deps;

  try {
    const { roomName } = createGroupRoomPayloadSchema.parse(payload);
    if (!deps.rateLimiter.tryCreateGroup(userId)) {
      socket.emit('error', errorPayload('rateLimit.roomCreate'));
      return;
    }

    const room = await roomService.createGroupRoom(roomName, userId);
    await socket.join(room.id);
    await joinUserSocketsToRoom(io, userId, room.id);

    const user = await userService.getUser(userId);
    const systemMessage = await messageService.createSystemMessage(
      room.id,
      systemEvent('group.created', { actor: user?.nickname ?? null }),
    );

    const summary = await roomService.buildSummary(room, userId);
    socket.emit('room:created', { room: summary, messages: [await messageService.toView(systemMessage)] });
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}

async function handleRoomsGet(socket: AppSocket, deps: RoomSocketDeps): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  try {
    const rooms = await deps.roomService.getVisibleRoomsForUser(userId);
    const summaries = await deps.roomService.buildSummaries(rooms, userId);
    const roomIds = rooms.map((room) => room.id);

    await socket.join(roomIds);

    const stillParticipating = await deps.roomService.findParticipatingRoomIds(userId, roomIds);
    const lost = roomIds.filter((roomId) => !stillParticipating.has(roomId));
    await Promise.all(
      lost.map(async (roomId) => {
        await socket.leave(roomId);
      }),
    );

    socket.emit('rooms:list', { rooms: summaries.filter((summary) => stillParticipating.has(summary.id)) });
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}

async function handleJoinByCode(io: AppServer, socket: AppSocket, deps: RoomSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  const { roomService, userService, messageService } = deps;

  try {
    const { roomCode } = joinByCodePayloadSchema.parse(payload);
    const normalizedCode = roomCode.toUpperCase().trim();

    if (normalizedCode.length < ROOM_CODE_MIN_LENGTH || normalizedCode.length > ROOM_CODE_MAX_LENGTH) {
      socket.emit('error', errorPayload('room.invalidCode'));
      return;
    }

    if (!deps.rateLimiter.tryJoinAttempt(userId)) {
      socket.emit('error', errorPayload('rateLimit.roomJoin'));
      return;
    }

    const { room, joined } = await roomService.joinByCode(normalizedCode, userId);
    deps.rateLimiter.forgiveJoinAttempt(userId);
    await socket.join(room.id);
    await joinUserSocketsToRoom(io, userId, room.id);

    const current = await roomService.getRoomById(room.id);
    if (!current || !roomService.isParticipant(current, userId)) {
      await removeUserSocketsFromRoom(io, userId, room.id);
      socket.emit('error', errorPayload('room.notFound'));
      return;
    }

    if (joined) {
      const user = await userService.getUser(userId);
      if (user) {
        const systemMessage = await messageService.createSystemMessage(
          room.id,
          systemEvent('group.memberJoined', { actor: user.nickname }),
        );
        io.to(room.id).emit('message:new', await messageService.toView(systemMessage));

        const participants = await roomService.buildParticipantViews(room);
        socket.to(room.id).emit('group:user-joined', { roomId: room.id, participants });
      }
    }

    const messageViews = await getInitialMessageViews(deps, room, userId);
    const summary = await roomService.buildSummary(room, userId);
    socket.emit('room:joined', { room: summary, messages: messageViews });

    const summaries = await roomService.listSummariesForUser(userId);
    socket.emit('rooms:list', { rooms: summaries });
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}

async function handleJoinRoom(socket: AppSocket, deps: RoomSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  try {
    const { roomId } = roomIdPayloadSchema.parse(payload);
    const room = await deps.roomService.getRoomById(roomId);
    if (!room || !deps.roomService.isParticipant(room, userId)) {
      socket.emit('error', errorPayload('room.notFound'));
      return;
    }

    await socket.join(roomId);

    const stillParticipating = await deps.roomService.findParticipatingRoomIds(userId, [roomId]);
    if (!stillParticipating.has(roomId)) {
      await socket.leave(roomId);
      socket.emit('error', errorPayload('room.notFound'));
    }
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}

async function handleDeleteRoom(io: AppServer, socket: AppSocket, deps: RoomSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  const { roomService } = deps;

  try {
    const { roomId } = roomIdPayloadSchema.parse(payload);
    const room = await roomService.getRoomById(roomId);
    if (!room || !roomService.isParticipant(room, userId)) {
      socket.emit('error', errorPayload('room.notFound'));
      return;
    }

    if (deps.shouldResetInsteadOfDelete?.(room)) {
      await roomService.resetVisibilityForUser(room, userId);
      const summary = await roomService.buildSummary(room, userId);
      socket.emit('room:new', { room: summary, messages: [] });
      deps.onRoomCreated?.({ io, room, locale: socketLocale(socket) });
      return;
    }

    await roomService.deleteForUser(roomId, userId);
    emitToUser(io, userId).emit('room:deleted', { roomId });
    await removeUserSocketsFromRoom(io, userId, roomId);
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}

async function handleLeaveGroup(io: AppServer, socket: AppSocket, deps: RoomSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  const { roomService, userService, messageService } = deps;

  try {
    const { roomId } = roomIdPayloadSchema.parse(payload);
    const user = await userService.getUser(userId);
    const updatedRoom = await roomService.leaveGroup(roomId, userId);
    if (!updatedRoom) {
      return;
    }

    await socket.leave(roomId);
    await removeUserSocketsFromRoom(io, userId, roomId);
    emitToUser(io, userId).emit('group:left', { roomId });

    if (user) {
      const remaining = await roomService.buildParticipantViews(updatedRoom);

      io.to(roomId).emit('group:user-left', {
        roomId,
        userId,
        userName: user.nickname,
        participants: remaining,
      });

      const systemMessage = await messageService.createSystemMessage(roomId, systemEvent('group.memberLeft', { actor: user.nickname }));
      io.to(roomId).emit('message:new', await messageService.toView(systemMessage));
    }
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}

async function handleRemoveMember(io: AppServer, socket: AppSocket, deps: RoomSocketDeps, payload: unknown): Promise<void> {
  const actingUserId = requireSocketUserId(socket);
  if (!actingUserId) {
    return;
  }

  const { roomService, userService, messageService } = deps;

  try {
    const { roomId, userId: targetUserId } = memberActionPayloadSchema.parse(payload);
    const [actingUser, targetUser] = await Promise.all([
      userService.getUser(actingUserId),
      userService.getUser(targetUserId),
    ]);

    const updatedRoom = await roomService.removeMember(roomId, actingUserId, targetUserId);
    if (!updatedRoom || !actingUser || !targetUser) {
      return;
    }

    const remaining = await roomService.buildParticipantViews(updatedRoom);

    emitToUser(io, targetUserId).emit('group:left', { roomId });
    await removeUserSocketsFromRoom(io, targetUserId, roomId);

    io.to(roomId).emit('group:user-left', {
      roomId,
      userId: targetUserId,
      userName: targetUser.nickname,
      participants: remaining,
      ...(updatedRoom.roomCode ? { roomCode: updatedRoom.roomCode } : {}),
    });

    const systemMessage = await messageService.createSystemMessage(
      roomId,
      systemEvent('group.memberRemoved', { target: targetUser.nickname, actor: actingUser.nickname }),
    );
    io.to(roomId).emit('message:new', await messageService.toView(systemMessage));
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}

async function handlePromoteAdmin(io: AppServer, socket: AppSocket, deps: RoomSocketDeps, payload: unknown): Promise<void> {
  const actingUserId = requireSocketUserId(socket);
  if (!actingUserId) {
    return;
  }

  const { roomService, userService, messageService } = deps;

  try {
    const { roomId, userId: targetUserId } = memberActionPayloadSchema.parse(payload);
    const [actingUser, targetUser] = await Promise.all([
      userService.getUser(actingUserId),
      userService.getUser(targetUserId),
    ]);

    const updatedRoom = await roomService.promoteAdmin(roomId, actingUserId, targetUserId);
    if (!updatedRoom || !actingUser || !targetUser) {
      return;
    }

    const participants = await roomService.buildParticipantViews(updatedRoom);
    io.to(roomId).emit('group:participants-updated', { roomId, participants });

    const systemMessage = await messageService.createSystemMessage(
      roomId,
      systemEvent('group.adminPromoted', { target: targetUser.nickname, actor: actingUser.nickname }),
    );
    io.to(roomId).emit('message:new', await messageService.toView(systemMessage));
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}

async function handleBlockUser(io: AppServer, socket: AppSocket, deps: RoomSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  try {
    const { roomId, blockedUserId } = blockPayloadSchema.parse(payload);
    const room = await deps.roomService.blockUser(roomId, userId, blockedUserId);
    if (!room) {
      return;
    }

    emitToUser(io, userId).emit('user:blocked', { roomId, blockedUserId, blockedBy: room.blockedBy, isBlocking: true });
    emitToUser(io, blockedUserId).emit('user:blocked', {
      roomId,
      blockedByUserId: userId,
      blockedBy: room.blockedBy,
      isBlocking: false,
    });
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}

async function handleUnblockUser(io: AppServer, socket: AppSocket, deps: RoomSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  try {
    const { roomId, blockedUserId } = blockPayloadSchema.parse(payload);
    const room = await deps.roomService.unblockUser(roomId, userId, blockedUserId);
    if (!room) {
      return;
    }

    emitToUser(io, userId).emit('user:unblocked', { roomId, blockedUserId, blockedBy: room.blockedBy, isBlocking: true });
    emitToUser(io, blockedUserId).emit('user:unblocked', {
      roomId,
      blockedByUserId: userId,
      blockedBy: room.blockedBy,
      isBlocking: false,
    });
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}

async function handlePublishRoomKey(io: AppServer, socket: AppSocket, deps: RoomSocketDeps, payload: unknown): Promise<void> {
  const actingUserId = requireSocketUserId(socket);
  if (!actingUserId) {
    return;
  }

  const { roomService, roomKeyRepository } = deps;

  try {
    const { roomId, keys } = publishRoomKeyPayloadSchema.parse(payload);
    const room = await roomService.getRoomById(roomId);
    if (!room || !roomService.isParticipant(room, actingUserId)) {
      return;
    }

    const validKeys = keys.filter((key) => roomService.isParticipant(room, key.userId));

    const hasOwnKey = validKeys.some((key) => key.userId === actingUserId);
    const assistantRoom = deps.canReplaceRoomKey?.(room, actingUserId) === true;
    const aloneInRoom = room.participants.length === 1;
    const writes = validKeys.map((key) => ({
      ...key,
      replaceable:
        assistantRoom ||
        (key.userId === actingUserId ? aloneInRoom : deps.rateLimiter.hasPendingKeyRequest(key.userId, roomId)),
    }));

    const { rejected, stored } = await roomKeyRepository.publishBatch(roomId, writes, hasOwnKey);
    if (rejected) {
      socket.emit('e2e:room-key-rejected', { roomId });
      return;
    }

    for (const key of stored) {
      if (key.userId !== actingUserId) {
        deps.rateLimiter.consumePendingKeyRequest(key.userId, roomId);
      }
    }
    const publishedKeys = stored.map(({ userId, sealedKey }) => ({ userId, sealedKey }));

    for (const key of publishedKeys) {
      const target = key.userId === actingUserId ? socket.to(userRoom(actingUserId)) : emitToUser(io, key.userId);
      target.emit('e2e:room-key', { roomId, sealedKey: key.sealedKey });
    }

    if (publishedKeys.length > 0) {
      deps.onRoomKeyPublished?.({ io, room });
    }
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}

async function handleGetRoomKeys(socket: AppSocket, deps: RoomSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  if (exceedsLookupLimit(payload, 'roomIds')) {
    socket.emit('error', lookupTooLargePayload('e2e:get-room-keys'));
    return;
  }

  try {
    const { roomIds } = getRoomKeysPayloadSchema.parse(payload);
    const keys = await deps.roomKeyRepository.findForParticipantInRooms(roomIds, userId);

    socket.emit('e2e:room-keys', { keys });
  } catch (error) {
    socket.emit('error', { ...extractErrorPayload(error), event: 'e2e:get-room-keys' });
  }
}

async function handleRequestRoomKey(socket: AppSocket, deps: RoomSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  try {
    const { roomId } = roomIdPayloadSchema.parse(payload);
    const room = await deps.roomService.getRoomById(roomId);
    if (!room || !deps.roomService.isParticipant(room, userId)) {
      return;
    }

    if (!deps.rateLimiter.tryKeyRequest(userId, roomId)) {
      return;
    }

    socket.to(roomId).emit('e2e:key-request', { roomId, requesterId: userId });
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}
