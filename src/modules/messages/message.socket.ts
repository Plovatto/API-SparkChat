import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { registerSocketEvent } from '../../docs/socket-registry.js';
import type { AppServer, AppSocket } from '../../sockets/events.js';
import type { RoomService } from '../rooms/index.js';
import type { UserService } from '../users/index.js';
import type { MessageService } from './message.service.js';
import type { RecordingService } from './recording.service.js';
import type { TypingService } from './typing.service.js';

const sendMessagePayloadSchema = z
  .object({
    roomId: z.string().trim().min(1),
    content: z.string().trim().min(1).max(5000),
    type: z.enum(['text', 'image', 'audio']).default('text'),
    duration: z.number().int().positive().optional(),
    replyToMessageId: z.string().trim().min(1).optional(),
  })
  .refine((data) => data.type !== 'audio' || typeof data.duration === 'number', {
    message: 'duration é obrigatório para mensagens de áudio.',
    path: ['duration'],
  });

const roomIdPayloadSchema = z.object({
  roomId: z.string().trim().min(1),
});

const deleteMessagePayloadSchema = z.object({
  messageId: z.string().trim().min(1),
});

const audioPlayedPayloadSchema = z.object({
  messageId: z.string().trim().min(1),
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
registerSocketEvent({
  event: 'messages:get',
  direction: 'client-to-server',
  module: 'messages',
  payloadSchema: zodToJsonSchema(roomIdPayloadSchema),
});
registerSocketEvent({
  event: 'message:delete',
  direction: 'client-to-server',
  module: 'messages',
  payloadSchema: zodToJsonSchema(deleteMessagePayloadSchema),
});
registerSocketEvent({
  event: 'typing:start',
  direction: 'client-to-server',
  module: 'messages',
  payloadSchema: zodToJsonSchema(roomIdPayloadSchema),
});
registerSocketEvent({
  event: 'typing:stop',
  direction: 'client-to-server',
  module: 'messages',
  payloadSchema: zodToJsonSchema(roomIdPayloadSchema),
});
registerSocketEvent({
  event: 'recording:start',
  direction: 'client-to-server',
  module: 'messages',
  payloadSchema: zodToJsonSchema(roomIdPayloadSchema),
});
registerSocketEvent({
  event: 'recording:stop',
  direction: 'client-to-server',
  module: 'messages',
  payloadSchema: zodToJsonSchema(roomIdPayloadSchema),
});
registerSocketEvent({
  event: 'audio:played',
  direction: 'client-to-server',
  module: 'messages',
  payloadSchema: zodToJsonSchema(audioPlayedPayloadSchema),
});
registerSocketEvent({ event: 'message:new', direction: 'server-to-client', module: 'messages' });
registerSocketEvent({ event: 'message:mark-read-done', direction: 'server-to-client', module: 'messages' });
registerSocketEvent({ event: 'message:read-receipt', direction: 'server-to-client', module: 'messages' });
registerSocketEvent({ event: 'messages:list', direction: 'server-to-client', module: 'messages' });
registerSocketEvent({ event: 'message:deleted', direction: 'server-to-client', module: 'messages' });
registerSocketEvent({ event: 'message:updated', direction: 'server-to-client', module: 'messages' });
registerSocketEvent({ event: 'typing:update', direction: 'server-to-client', module: 'messages' });
registerSocketEvent({ event: 'recording:update', direction: 'server-to-client', module: 'messages' });

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
  userService: UserService,
  typingService: TypingService,
  recordingService: RecordingService,
): void {
  socket.on('message:send', (payload) => {
    void handleSendMessage(io, socket, messageService, roomService, userService, payload);
  });

  socket.on('message:mark-read', (payload) => {
    void handleMarkRead(socket, messageService, payload);
  });

  socket.on('messages:get', (payload) => {
    void handleGetMessages(socket, messageService, roomService, payload);
  });

  socket.on('message:delete', (payload) => {
    void handleDeleteMessage(io, socket, messageService, payload);
  });

  socket.on('typing:start', (payload) => {
    handleTypingStart(socket, typingService, payload);
  });

  socket.on('typing:stop', (payload) => {
    handleTypingStop(socket, typingService, payload);
  });

  socket.on('recording:start', (payload) => {
    handleRecordingStart(socket, recordingService, payload);
  });

  socket.on('recording:stop', (payload) => {
    handleRecordingStop(socket, recordingService, payload);
  });

  socket.on('audio:played', (payload) => {
    void handleAudioPlayed(io, socket, messageService, payload);
  });

  socket.on('disconnect', () => {
    handleTypingDisconnect(io, socket, typingService);
    handleRecordingDisconnect(io, socket, recordingService);
  });
}

async function handleSendMessage(
  io: AppServer,
  socket: AppSocket,
  messageService: MessageService,
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
    const { roomId, content, type, duration, replyToMessageId } = sendMessagePayloadSchema.parse(payload);
    const room = await roomService.getRoomById(roomId);

    if (!room) {
      socket.emit('error', { message: 'Sala não encontrada.' });
      return;
    }

    if (roomService.isBlocked(room, userId)) {
      socket.emit('error', { message: 'Você não pode enviar mensagens nesta conversa devido a bloqueios.' });
      return;
    }

    const newlyVisibleUserIds = roomService.getNewlyVisibleParticipants(room, userId);

    const message = await messageService.sendMessage({ roomId, senderId: userId, content, type, duration, replyToMessageId });
    const updatedRoom = (await roomService.makeVisibleForAll(room)) ?? room;

    const view = await messageService.toView(message);
    io.to(roomId).emit('message:new', view);

    for (const newlyVisibleUserId of newlyVisibleUserIds) {
      const recipient = await userService.getUser(newlyVisibleUserId);
      if (!recipient?.socketId) {
        continue;
      }

      const summary = await roomService.buildSummary(updatedRoom, newlyVisibleUserId);
      const messages = await messageService.toViews(await messageService.getRoomMessages(roomId));
      io.to(recipient.socketId).emit('room:new', { room: summary, messages });
    }
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleGetMessages(
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
    const { roomId } = roomIdPayloadSchema.parse(payload);
    const room = await roomService.getRoomById(roomId);

    if (!room || !roomService.isParticipant(room, userId)) {
      socket.emit('error', { message: 'Sala não encontrada.' });
      return;
    }

    const messages = await messageService.getRoomMessages(roomId);
    const views = await messageService.toViews(messages);
    socket.emit('messages:list', { roomId, messages: views });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleDeleteMessage(
  io: AppServer,
  socket: AppSocket,
  messageService: MessageService,
  payload: unknown,
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  try {
    const { messageId } = deleteMessagePayloadSchema.parse(payload);
    const updated = await messageService.deleteMessage(messageId, userId);
    io.to(updated.roomId).emit('message:deleted', { messageId, roomId: updated.roomId });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleAudioPlayed(
  io: AppServer,
  socket: AppSocket,
  messageService: MessageService,
  payload: unknown,
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  try {
    const { messageId } = audioPlayedPayloadSchema.parse(payload);
    const updated = await messageService.markAudioPlayed(messageId, userId);
    if (!updated) {
      return;
    }

    const view = await messageService.toView(updated);
    io.to(updated.roomId).emit('message:updated', view);
  } catch {
    return;
  }
}

function handleTypingStart(socket: AppSocket, typingService: TypingService, payload: unknown): void {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  try {
    const { roomId } = roomIdPayloadSchema.parse(payload);
    const users = typingService.startTyping(roomId, userId);
    socket.to(roomId).emit('typing:update', { roomId, users });
  } catch {
    return;
  }
}

function handleTypingStop(socket: AppSocket, typingService: TypingService, payload: unknown): void {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  try {
    const { roomId } = roomIdPayloadSchema.parse(payload);
    const users = typingService.stopTyping(roomId, userId);
    socket.to(roomId).emit('typing:update', { roomId, users });
  } catch {
    return;
  }
}

function handleTypingDisconnect(io: AppServer, socket: AppSocket, typingService: TypingService): void {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  for (const { roomId, users } of typingService.removeUserEverywhere(userId)) {
    io.to(roomId).emit('typing:update', { roomId, users });
  }
}

function handleRecordingStart(socket: AppSocket, recordingService: RecordingService, payload: unknown): void {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  try {
    const { roomId } = roomIdPayloadSchema.parse(payload);
    const users = recordingService.startRecording(roomId, userId);
    socket.to(roomId).emit('recording:update', { roomId, users });
  } catch {
    return;
  }
}

function handleRecordingStop(socket: AppSocket, recordingService: RecordingService, payload: unknown): void {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  try {
    const { roomId } = roomIdPayloadSchema.parse(payload);
    const users = recordingService.stopRecording(roomId, userId);
    socket.to(roomId).emit('recording:update', { roomId, users });
  } catch {
    return;
  }
}

function handleRecordingDisconnect(io: AppServer, socket: AppSocket, recordingService: RecordingService): void {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  for (const { roomId, users } of recordingService.removeUserEverywhere(userId)) {
    io.to(roomId).emit('recording:update', { roomId, users });
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
