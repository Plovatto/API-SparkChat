import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { registerSocketEvent } from '../../docs/socket-registry.js';
import type { AppServer, AppSocket } from '../../sockets/events.js';
import type { MessageService } from '../messages/index.js';
import type { UserService } from '../users/index.js';
import type { RoomService } from './room.service.js';
import type { RoomRecord } from './room.types.js';

const CHAT_CODE_PATTERN = /^[A-Z0-9]{6}$/;
const ROOM_CODE_MIN_LENGTH = 4;
const INITIAL_MESSAGES_LIMIT = 20;

const createPrivateRoomPayloadSchema = z.object({
  targetChatCode: z.string().trim().min(1),
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

const roomIdPayloadJsonSchema = zodToJsonSchema(roomIdPayloadSchema);
const blockPayloadJsonSchema = zodToJsonSchema(blockPayloadSchema);

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
registerSocketEvent({ event: 'user:block', direction: 'client-to-server', module: 'rooms', payloadSchema: blockPayloadJsonSchema });
registerSocketEvent({ event: 'user:unblock', direction: 'client-to-server', module: 'rooms', payloadSchema: blockPayloadJsonSchema });
registerSocketEvent({ event: 'room:joined', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'room:new', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'room:created', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'room:deleted', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'rooms:list', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'group:user-joined', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'group:left', direction: 'server-to-client', module: 'rooms' });
registerSocketEvent({ event: 'group:user-left', direction: 'server-to-client', module: 'rooms' });
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
): void {
  socket.on('room:create-private', (payload) => {
    void handleCreatePrivateRoom(io, socket, roomService, userService, messageService, payload);
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
    void handleJoinRoom(socket, payload);
  });

  socket.on('room:delete', (payload) => {
    void handleDeleteRoom(socket, roomService, payload);
  });

  socket.on('group:leave', (payload) => {
    void handleLeaveGroup(socket, roomService, userService, messageService, payload);
  });

  socket.on('user:block', (payload) => {
    void handleBlockUser(io, socket, roomService, userService, payload);
  });

  socket.on('user:unblock', (payload) => {
    void handleUnblockUser(io, socket, roomService, userService, payload);
  });
}

async function handleCreatePrivateRoom(
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
    const { targetChatCode } = createPrivateRoomPayloadSchema.parse(payload);
    const normalizedCode = targetChatCode.toUpperCase().trim();

    if (!CHAT_CODE_PATTERN.test(normalizedCode)) {
      socket.emit('error', { message: 'Formato de código inválido.' });
      return;
    }

    const targetUser = await userService.getUserByChatCode(normalizedCode);
    if (!targetUser) {
      socket.emit('error', { message: 'Usuário não encontrado.' });
      return;
    }

    const room = await roomService.createPrivateRoom(userId, targetUser.id);
    await socket.join(room.id);

    if (targetUser.socketId) {
      await io.sockets.sockets.get(targetUser.socketId)?.join(room.id);
    }

    const messageViews = await getInitialMessageViews(roomService, messageService, room, userId);

    const summaryForViewer = await roomService.buildSummary(room, userId);
    socket.emit('room:joined', { room: summaryForViewer, messages: messageViews });
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
        const participants = participantRecords
          .filter((participant): participant is NonNullable<typeof participant> => participant !== null)
          .map((participant) => roomService.toParticipantView(participant));

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

async function handleJoinRoom(socket: AppSocket, payload: unknown): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { roomId } = roomIdPayloadSchema.parse(payload);
    await socket.join(roomId);
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleDeleteRoom(socket: AppSocket, roomService: RoomService, payload: unknown): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { roomId } = roomIdPayloadSchema.parse(payload);
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
      const remaining = remainingRecords
        .filter((participant): participant is NonNullable<typeof participant> => participant !== null)
        .map((participant) => roomService.toParticipantView(participant));

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
    const room = await roomService.unblockUser(roomId, blockedUserId);
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
