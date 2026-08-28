import { z } from 'zod';
import type { UserService } from '../users/index.js';
import type { AppServer, AppSocket } from '../../sockets/events.js';
import type { RoomService } from './room.service.js';

const CHAT_CODE_PATTERN = /^[A-Z0-9]{6}$/;

const createPrivateRoomPayloadSchema = z.object({
  targetChatCode: z.string().trim().min(1),
});

const createGroupRoomPayloadSchema = z.object({
  roomName: z.string().trim().min(1),
});

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Erro inesperado.';
}

export function registerRoomSocketHandlers(
  io: AppServer,
  socket: AppSocket,
  roomService: RoomService,
  userService: UserService,
): void {
  socket.on('room:create-private', (payload) => {
    void handleCreatePrivateRoom(io, socket, roomService, userService, payload);
  });

  socket.on('room:create-group', (payload) => {
    void handleCreateGroupRoom(socket, roomService, payload);
  });

  socket.on('rooms:get', () => {
    void handleRoomsGet(socket, roomService);
  });
}

async function handleCreatePrivateRoom(
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

    const summaryForViewer = await roomService.buildSummary(room, userId);
    socket.emit('room:joined', { room: summaryForViewer, messages: [] });

    if (targetUser.socketId) {
      const summaryForTarget = await roomService.buildSummary(room, targetUser.id);
      io.to(targetUser.socketId).emit('room:new', { room: summaryForTarget, messages: [] });
    }
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleCreateGroupRoom(socket: AppSocket, roomService: RoomService, payload: unknown): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { roomName } = createGroupRoomPayloadSchema.parse(payload);
    const room = await roomService.createGroupRoom(roomName, userId);
    await socket.join(room.id);

    const summary = await roomService.buildSummary(room, userId);
    socket.emit('room:created', { room: summary, messages: [] });
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
