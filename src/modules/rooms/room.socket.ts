import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { registerSocketEvent } from '../../docs/socket-registry.js';
import type { AppServer, AppSocket } from '../../sockets/events.js';
import type { MessageService } from '../messages/index.js';
import type { UserService } from '../users/index.js';
import type { RoomKeyRepository } from './room.e2e.js';
import type { RoomService } from './room.service.js';
import type { RoomRecord } from './room.types.js';

export type OnRoomCreatedHook = (context: { io: AppServer; room: RoomRecord }) => void;
export type ShouldResetInsteadOfDeleteHook = (room: RoomRecord) => boolean;

const ROOM_CODE_MIN_LENGTH = 4;
const INITIAL_MESSAGES_LIMIT = 20;

const createPrivateRoomPayloadSchema = z.object({
  targetNickname: z.string().trim().min(1),
});

const createGroupRoomPayloadSchema = z.object({
  roomName: z.string().trim().min(1),
});

const joinByCodePayloadSchema = z.object({
  roomCode: z.string().trim().min(1),
});

const roomIdPayloadSchema = z.object({
  roomId: z.string().trim().min(1),
});

const blockPayloadSchema = z.object({
  roomId: z.string().trim().min(1),
  blockedUserId: z.string().trim().min(1),
});

const memberActionPayloadSchema = z.object({
  roomId: z.string().trim().min(1),
  userId: z.string().trim().min(1),
});

const MAX_SEALED_KEY_LENGTH = 2000;

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
  roomIds: z.array(z.string().trim().min(1)).min(1).max(200),
});

const roomIdPayloadJsonSchema = zodToJsonSchema(roomIdPayloadSchema);
const blockPayloadJsonSchema = zodToJsonSchema(blockPayloadSchema);
const memberActionPayloadJsonSchema = zodToJsonSchema(memberActionPayloadSchema);
const publishRoomKeyPayloadJsonSchema = zodToJsonSchema(publishRoomKeyPayloadSchema);
const getRoomKeysPayloadJsonSchema = zodToJsonSchema(getRoomKeysPayloadSchema);

registerSocketEvent({
  event: 'room:create-private',
  direction: 'client-to-server',
  module: 'rooms',
  payloadSchema: zodToJsonSchema(createPrivateRoomPayloadSchema),
});
registerSocketEvent({
  event: 'room:create-group',
  direction: 'client-to-server',
  module: 'rooms',
  payloadSchema: zodToJsonSchema(createGroupRoomPayloadSchema),
});
registerSocketEvent({
  event: 'room:join-by-code',
  direction: 'client-to-server',
  module: 'rooms',
  payloadSchema: zodToJsonSchema(joinByCodePayloadSchema),
});
registerSocketEvent({ event: 'room:join', direction: 'client-to-server', module: 'rooms', payloadSchema: roomIdPayloadJsonSchema });
registerSocketEvent({ event: 'room:delete', direction: 'client-to-server', module: 'rooms', payloadSchema: roomIdPayloadJsonSchema });
registerSocketEvent({ event: 'rooms:get', direction: 'client-to-server', module: 'rooms' });
registerSocketEvent({ event: 'group:leave', direction: 'client-to-server', module: 'rooms', payloadSchema: roomIdPayloadJsonSchema });
registerSocketEvent({ event: 'group:remove-member', direction: 'client-to-server', module: 'rooms', payloadSchema: memberActionPayloadJsonSchema });
registerSocketEvent({ event: 'group:promote-admin', direction: 'client-to-server', module: 'rooms', payloadSchema: memberActionPayloadJsonSchema });
registerSocketEvent({ event: 'user:block', direction: 'client-to-server', module: 'rooms', payloadSchema: blockPayloadJsonSchema });
registerSocketEvent({ event: 'user:unblock', direction: 'client-to-server', module: 'rooms', payloadSchema: blockPayloadJsonSchema });
registerSocketEvent({
  event: 'e2e:publish-room-key',
  direction: 'client-to-server',
  module: 'rooms',
  payloadSchema: publishRoomKeyPayloadJsonSchema,
});
registerSocketEvent({
  event: 'e2e:get-room-keys',
  direction: 'client-to-server',
  module: 'rooms',
  payloadSchema: getRoomKeysPayloadJsonSchema,
});
registerSocketEvent({
  event: 'e2e:request-room-key',
  direction: 'client-to-server',
  module: 'rooms',
  payloadSchema: roomIdPayloadJsonSchema,
});
registerSocketEvent({ event: 'e2e:room-keys', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'e2e:room-key', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'e2e:key-request', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'room:joined', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'room:new', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'room:created', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'room:deleted', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'rooms:list', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'group:user-joined', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'group:left', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'group:user-left', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'group:participants-updated', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'user:blocked', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'user:unblocked', direction: 'server-to-client', module: 'rooms' });

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Erro inesperado.';
}

async function getInitialMessageViews(
  roomService: RoomService,
  messageService: MessageService,
  room: RoomRecord,
  userId: string,
) {
  const after = roomService.getVisibilityCutoff(room, userId);
  const { messages } = await messageService.getRoomMessagesPage(room.id, { after, limit: INITIAL_MESSAGES_LIMIT });
  return messageService.toViews(messages);
}

export function registerRoomSocketHandlers(
  io: AppServer,
  socket: AppSocket,
  roomService: RoomService,
  userService: UserService,
  messageService: MessageService,
  roomKeyRepository: RoomKeyRepository,
  onRoomCreated?: OnRoomCreatedHook,
  shouldResetInsteadOfDelete?: ShouldResetInsteadOfDeleteHook,
): void {
  socket.on('room:create-private', (payload) => {
    void handleCreatePrivateRoom(io, socket, roomService, userService, messageService, payload, onRoomCreated);
  });

  socket.on('room:create-group', (payload) => {
    void handleCreateGroupRoom(socket, roomService, userService, messageService, payload);
  });

  socket.on('rooms:get', () => {
    void handleRoomsGet(socket, roomService);
  });

  socket.on('room:join-by-code', (payload) => {
    void handleJoinByCode(io, socket, roomService, userService, messageService, payload);
  });

  socket.on('room:join', (payload) => {
    void handleJoinRoom(socket, roomService, payload);
  });

  socket.on('room:delete', (payload) => {
    void handleDeleteRoom(io, socket, roomService, payload, onRoomCreated, shouldResetInsteadOfDelete);
  });

  socket.on('group:leave', (payload) => {
    void handleLeaveGroup(socket, roomService, userService, messageService, payload);
  });

  socket.on('group:remove-member', (payload) => {
    void handleRemoveMember(io, socket, roomService, userService, messageService, payload);
  });

  socket.on('group:promote-admin', (payload) => {
    void handlePromoteAdmin(io, socket, roomService, userService, messageService, payload);
  });

  socket.on('user:block', (payload) => {
    void handleBlockUser(io, socket, roomService, userService, payload);
  });

  socket.on('user:unblock', (payload) => {
    void handleUnblockUser(io, socket, roomService, userService, payload);
  });

  socket.on('e2e:publish-room-key', (payload) => {
    void handlePublishRoomKey(io, socket, roomService, userService, roomKeyRepository, payload);
  });

  socket.on('e2e:get-room-keys', (payload) => {
    void handleGetRoomKeys(socket, roomService, roomKeyRepository, payload);
  });

  socket.on('e2e:request-room-key', (payload) => {
    void handleRequestRoomKey(socket, roomService, payload);
  });
}

async function handleCreatePrivateRoom(
  io: AppServer,
  socket: AppSocket,
  roomService: RoomService,
  userService: UserService,
  messageService: MessageService,
  payload: unknown,
  onRoomCreated?: OnRoomCreatedHook,
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { targetNickname } = createPrivateRoomPayloadSchema.parse(payload);

    const targetUser = await userService.getUserByNickname(targetNickname);
    if (!targetUser) {
      socket.emit('error', { message: 'Usuário não encontrado.' });
      return;
    }

    if (targetUser.id === userId) {
      socket.emit('error', { message: 'Você não pode iniciar uma conversa consigo mesmo.' });
      return;
    }

    const existingRoom = await roomService.findPrivateRoomBetween(userId, targetUser.id);
    const room = await roomService.createPrivateRoom(userId, targetUser.id);
    await socket.join(room.id);

    if (targetUser.socketId) {
      await io.sockets.sockets.get(targetUser.socketId)?.join(room.id);
    }

    const messageViews = await getInitialMessageViews(roomService, messageService, room, userId);

    const summaryForViewer = await roomService.buildSummary(room, userId);
    socket.emit('room:joined', { room: summaryForViewer, messages: messageViews });

    if (!existingRoom) {
      onRoomCreated?.({ io, room });
    }
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleCreateGroupRoom(
  socket: AppSocket,
  roomService: RoomService,
  userService: UserService,
  messageService: MessageService,
  payload: unknown,
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { roomName } = createGroupRoomPayloadSchema.parse(payload);
    const room = await roomService.createGroupRoom(roomName, userId);
    await socket.join(room.id);

    const user = await userService.getUser(userId);
    const systemMessage = await messageService.createSystemMessage(
      room.id,
      `${user?.nickname ?? 'Alguém'} criou o grupo`,
    );

    const summary = await roomService.buildSummary(room, userId);
    socket.emit('room:created', { room: summary, messages: [await messageService.toView(systemMessage)] });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleRoomsGet(socket: AppSocket, roomService: RoomService): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const rooms = await roomService.getVisibleRoomsForUser(userId);
    const summaries = await Promise.all(rooms.map((room) => roomService.buildSummary(room, userId)));

    for (const room of rooms) {
      await socket.join(room.id);
    }

    socket.emit('rooms:list', { rooms: summaries });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleJoinByCode(
  io: AppServer,
  socket: AppSocket,
  roomService: RoomService,
  userService: UserService,
  messageService: MessageService,
  payload: unknown,
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { roomCode } = joinByCodePayloadSchema.parse(payload);
    const normalizedCode = roomCode.toUpperCase().trim();

    if (normalizedCode.length < ROOM_CODE_MIN_LENGTH) {
      socket.emit('error', { message: 'Formato de código inválido.' });
      return;
    }

    const { room, joined } = await roomService.joinByCode(normalizedCode, userId);
    await socket.join(room.id);

    if (joined) {
      const user = await userService.getUser(userId);
      if (user) {
        const systemMessage = await messageService.createSystemMessage(room.id, `${user.nickname} entrou no grupo`);
        io.to(room.id).emit('message:new', await messageService.toView(systemMessage));

        const participantRecords = await Promise.all(room.participants.map((id) => userService.getUser(id)));
        const admins = new Set(room.admins);
        const participants = participantRecords
          .filter((participant): participant is NonNullable<typeof participant> => participant !== null)
          .map((participant) => roomService.toParticipantView(participant, admins.has(participant.id)));

        socket.to(room.id).emit('group:user-joined', { roomId: room.id, participants });
      }
    }

    const messageViews = await getInitialMessageViews(roomService, messageService, room, userId);
    const summary = await roomService.buildSummary(room, userId);
    socket.emit('room:joined', { room: summary, messages: messageViews });

    const summaries = await roomService.listSummariesForUser(userId);
    socket.emit('rooms:list', { rooms: summaries });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleJoinRoom(socket: AppSocket, roomService: RoomService, payload: unknown): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { roomId } = roomIdPayloadSchema.parse(payload);
    const room = await roomService.getRoomById(roomId);
    if (!room || !roomService.isParticipant(room, userId)) {
      socket.emit('error', { message: 'Sala não encontrada.' });
      return;
    }

    await socket.join(roomId);
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleDeleteRoom(
  io: AppServer,
  socket: AppSocket,
  roomService: RoomService,
  payload: unknown,
  onRoomCreated?: OnRoomCreatedHook,
  shouldResetInsteadOfDelete?: ShouldResetInsteadOfDeleteHook,
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { roomId } = roomIdPayloadSchema.parse(payload);
    const room = await roomService.getRoomById(roomId);
    if (!room || !roomService.isParticipant(room, userId)) {
      socket.emit('error', { message: 'Sala não encontrada.' });
      return;
    }

    if (shouldResetInsteadOfDelete?.(room)) {
      await roomService.resetVisibilityForUser(room, userId);
      const summary = await roomService.buildSummary(room, userId);
      socket.emit('room:new', { room: summary, messages: [] });
      onRoomCreated?.({ io, room });
      return;
    }

    await roomService.deleteForUser(roomId, userId);
    socket.emit('room:deleted', { roomId });
    await socket.leave(roomId);
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleLeaveGroup(
  socket: AppSocket,
  roomService: RoomService,
  userService: UserService,
  messageService: MessageService,
  payload: unknown,
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { roomId } = roomIdPayloadSchema.parse(payload);
    const user = await userService.getUser(userId);
    const updatedRoom = await roomService.leaveGroup(roomId, userId);

    socket.emit('group:left', { roomId });

    if (updatedRoom && user) {
      const remainingRecords = await Promise.all(updatedRoom.participants.map((id) => userService.getUser(id)));
      const remainingAdmins = new Set(updatedRoom.admins);
      const remaining = remainingRecords
        .filter((participant): participant is NonNullable<typeof participant> => participant !== null)
        .map((participant) => roomService.toParticipantView(participant, remainingAdmins.has(participant.id)));

      socket.to(roomId).emit('group:user-left', {
        roomId,
        userId,
        userName: user.nickname,
        participants: remaining,
      });

      const systemMessage = await messageService.createSystemMessage(roomId, `${user.nickname} saiu do grupo`);
      socket.to(roomId).emit('message:new', await messageService.toView(systemMessage));
    }

    await socket.leave(roomId);
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleRemoveMember(
  io: AppServer,
  socket: AppSocket,
  roomService: RoomService,
  userService: UserService,
  messageService: MessageService,
  payload: unknown,
): Promise<void> {
  const actingUserId = socket.data.userId;
  if (!actingUserId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

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

    const remainingRecords = await Promise.all(updatedRoom.participants.map((id) => userService.getUser(id)));
    const remainingAdmins = new Set(updatedRoom.admins);
    const remaining = remainingRecords
      .filter((participant): participant is NonNullable<typeof participant> => participant !== null)
      .map((participant) => roomService.toParticipantView(participant, remainingAdmins.has(participant.id)));

    io.to(roomId).emit('group:user-left', {
      roomId,
      userId: targetUserId,
      userName: targetUser.nickname,
      participants: remaining,
    });

    if (targetUser.socketId) {
      const targetSocket = io.sockets.sockets.get(targetUser.socketId);
      targetSocket?.emit('group:left', { roomId });
      await targetSocket?.leave(roomId);
    }

    const systemMessage = await messageService.createSystemMessage(
      roomId,
      `${targetUser.nickname} foi removido do grupo por ${actingUser.nickname}`,
    );
    io.to(roomId).emit('message:new', await messageService.toView(systemMessage));
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handlePromoteAdmin(
  io: AppServer,
  socket: AppSocket,
  roomService: RoomService,
  userService: UserService,
  messageService: MessageService,
  payload: unknown,
): Promise<void> {
  const actingUserId = socket.data.userId;
  if (!actingUserId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

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

    const participantRecords = await Promise.all(updatedRoom.participants.map((id) => userService.getUser(id)));
    const admins = new Set(updatedRoom.admins);
    const participants = participantRecords
      .filter((participant): participant is NonNullable<typeof participant> => participant !== null)
      .map((participant) => roomService.toParticipantView(participant, admins.has(participant.id)));

    io.to(roomId).emit('group:participants-updated', { roomId, participants });

    const systemMessage = await messageService.createSystemMessage(
      roomId,
      `${targetUser.nickname} foi promovido a administrador por ${actingUser.nickname}`,
    );
    io.to(roomId).emit('message:new', await messageService.toView(systemMessage));
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleBlockUser(
  io: AppServer,
  socket: AppSocket,
  roomService: RoomService,
  userService: UserService,
  payload: unknown,
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { roomId, blockedUserId } = blockPayloadSchema.parse(payload);
    const room = await roomService.blockUser(roomId, userId, blockedUserId);
    if (!room) {
      return;
    }

    socket.emit('user:blocked', { roomId, blockedUserId, blockedBy: room.blockedBy, isBlocking: true });

    const blockedUser = await userService.getUser(blockedUserId);
    if (blockedUser?.socketId) {
      io.to(blockedUser.socketId).emit('user:blocked', {
        roomId,
        blockedByUserId: userId,
        blockedBy: room.blockedBy,
        isBlocking: false,
      });
    }
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleUnblockUser(
  io: AppServer,
  socket: AppSocket,
  roomService: RoomService,
  userService: UserService,
  payload: unknown,
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { roomId, blockedUserId } = blockPayloadSchema.parse(payload);
    const room = await roomService.unblockUser(roomId, userId, blockedUserId);
    if (!room) {
      return;
    }

    socket.emit('user:unblocked', { roomId, blockedUserId, blockedBy: room.blockedBy, isBlocking: true });

    const blockedUser = await userService.getUser(blockedUserId);
    if (blockedUser?.socketId) {
      io.to(blockedUser.socketId).emit('user:unblocked', {
        roomId,
        blockedByUserId: userId,
        blockedBy: room.blockedBy,
        isBlocking: false,
      });
    }
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handlePublishRoomKey(
  io: AppServer,
  socket: AppSocket,
  roomService: RoomService,
  userService: UserService,
  roomKeyRepository: RoomKeyRepository,
  payload: unknown,
): Promise<void> {
  const actingUserId = socket.data.userId;
  if (!actingUserId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { roomId, keys } = publishRoomKeyPayloadSchema.parse(payload);
    const room = await roomService.getRoomById(roomId);
    if (!room || !roomService.isParticipant(room, actingUserId)) {
      return;
    }

    const validKeys = keys.filter((key) => roomService.isParticipant(room, key.userId));

    await Promise.all(validKeys.map((key) => roomKeyRepository.publish(roomId, key.userId, key.sealedKey)));

    for (const key of validKeys) {
      if (key.userId === actingUserId) {
        continue;
      }

      const recipient = await userService.getUser(key.userId);
      if (recipient?.socketId) {
        io.to(recipient.socketId).emit('e2e:room-key', { roomId, sealedKey: key.sealedKey });
      }
    }
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleGetRoomKeys(
  socket: AppSocket,
  roomService: RoomService,
  roomKeyRepository: RoomKeyRepository,
  payload: unknown,
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { roomIds } = getRoomKeysPayloadSchema.parse(payload);
    const results: { roomId: string; sealedKey: string }[] = [];

    for (const roomId of roomIds) {
      const room = await roomService.getRoomById(roomId);
      if (!room || !roomService.isParticipant(room, userId)) {
        continue;
      }

      const sealedKey = await roomKeyRepository.findForUser(roomId, userId);
      if (sealedKey) {
        results.push({ roomId, sealedKey });
      }
    }

    socket.emit('e2e:room-keys', { keys: results });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleRequestRoomKey(socket: AppSocket, roomService: RoomService, payload: unknown): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { roomId } = roomIdPayloadSchema.parse(payload);
    const room = await roomService.getRoomById(roomId);
    if (!room || !roomService.isParticipant(room, userId)) {
      return;
    }

    socket.to(roomId).emit('e2e:key-request', { roomId, requesterId: userId });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}
