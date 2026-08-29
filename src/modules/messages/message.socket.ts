import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { registerSocketEvent } from '../../docs/socket-registry.js';
import type { AppServer, AppSocket } from '../../sockets/events.js';
import type { RoomService } from '../rooms/index.js';
import type { MessageService } from './message.service.js';

const sendMessagePayloadSchema = z.object({
  roomId: z.string().trim().min(1),
  content: z.string().trim().min(1).max(5000),
});

const roomIdPayloadSchema = z.object({
  roomId: z.string().trim().min(1),
});

registerSocketEvent({
  event: 'message:send',
  direction: 'client-to-server',
  module: 'messages',
  payloadSchema: zodToJsonSchema(sendMessagePayloadSchema),
});
registerSocketEvent({
  event: 'message:mark-read',
  direction: 'client-to-server',
  module: 'messages',
  payloadSchema: zodToJsonSchema(roomIdPayloadSchema),
});
registerSocketEvent({ event: 'message:new', direction: 'server-to-client', module: 'messages' });
registerSocketEvent({ event: 'message:mark-read-done', direction: 'server-to-client', module: 'messages' });
registerSocketEvent({ event: 'message:read-receipt', direction: 'server-to-client', module: 'messages' });

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Erro inesperado.';
}

export function registerMessageSocketHandlers(
  io: AppServer,
  socket: AppSocket,
  messageService: MessageService,
  roomService: RoomService,
): void {
  socket.on('message:send', (payload) => {
    void handleSendMessage(io, socket, messageService, roomService, payload);
  });

  socket.on('message:mark-read', (payload) => {
    void handleMarkRead(socket, messageService, payload);
  });
}

async function handleSendMessage(
  io: AppServer,
  socket: AppSocket,
  messageService: MessageService,
  roomService: RoomService,
  payload: unknown,
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { roomId, content } = sendMessagePayloadSchema.parse(payload);
    const room = await roomService.getRoomById(roomId);

    if (!room) {
      socket.emit('error', { message: 'Sala não encontrada.' });
      return;
    }

    if (roomService.isBlocked(room, userId)) {
      socket.emit('error', { message: 'Você não pode enviar mensagens nesta conversa devido a bloqueios.' });
      return;
    }

    const message = await messageService.sendMessage({ roomId, senderId: userId, content });
    await roomService.makeVisibleForAll(room);

    const view = await messageService.toView(message);
    io.to(roomId).emit('message:new', view);
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleMarkRead(socket: AppSocket, messageService: MessageService, payload: unknown): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { roomId } = roomIdPayloadSchema.parse(payload);
    const messages = await messageService.markRoomAsRead(roomId, userId);
    const unreadCount = messageService.countUnread(messages, userId);

    socket.emit('message:mark-read-done', { roomId, unreadCount });
    socket.to(roomId).emit('message:read-receipt', { roomId, userId });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}
