import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { uploadsUrlPrefix } from '../../config/paths.js';
import { registerSocketEvent } from '../../docs/socket-registry.js';
import type { AppServer, AppSocket } from '../../sockets/events.js';
import type { RoomService } from '../rooms/index.js';
import type { UserService } from '../users/index.js';
import { parseMentionedUserIds } from './message.mentions.js';
import type { MessageRateLimiter } from './message.rate-limiter.js';
import type { MessageService } from './message.service.js';
import type { RecordingService } from './recording.service.js';
import type { RoomPresenceService } from './room-presence.service.js';
import type { TypingService } from './typing.service.js';

const fileMetaSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1),
  size: z.number().int().positive(),
});

const sendMessagePayloadSchema = z
  .object({
    roomId: z.string().trim().min(1),
    content: z.string().trim().min(1).max(30000),
    type: z.enum(['text', 'image', 'audio', 'file']).default('text'),
    duration: z.number().int().positive().optional(),
    replyToMessageId: z.string().trim().min(1).optional(),
    clientTempId: z.string().trim().min(1).optional(),
    fileMeta: fileMetaSchema.optional(),
    mentionedUserIds: z.array(z.string().trim().min(1)).max(50).optional(),
  })
  .refine((data) => data.type !== 'audio' || typeof data.duration === 'number', {
    message: 'duration é obrigatório para mensagens de áudio.',
    path: ['duration'],
  })
  .refine((data) => data.type !== 'file' || data.fileMeta !== undefined, {
    message: 'fileMeta é obrigatório para mensagens do tipo file.',
    path: ['fileMeta'],
  });

const roomIdPayloadSchema = z.object({
  roomId: z.string().trim().min(1),
});

const markReadPayloadSchema = z.object({
  roomId: z.string().trim().min(1),
  messageIds: z.array(z.string().trim().min(1)).max(100).optional(),
});

const getMessagesPayloadSchema = z.object({
  roomId: z.string().trim().min(1),
  before: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
const INITIAL_MESSAGES_LIMIT = 20;

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
  payloadSchema: zodToJsonSchema(markReadPayloadSchema),
});
registerSocketEvent({
  event: 'messages:get',
  direction: 'client-to-server',
  module: 'messages',
  payloadSchema: zodToJsonSchema(getMessagesPayloadSchema),
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
registerSocketEvent({
  event: 'room:view-start',
  direction: 'client-to-server',
  module: 'messages',
  payloadSchema: zodToJsonSchema(roomIdPayloadSchema),
});
registerSocketEvent({
  event: 'room:view-stop',
  direction: 'client-to-server',
  module: 'messages',
  payloadSchema: zodToJsonSchema(roomIdPayloadSchema),
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

const uploadedMediaPathPattern = new RegExp(`^${uploadsUrlPrefix}/(images|audio|files)/[^/]+$`);

function isUploadedMediaUrl(content: string): boolean {
  try {
    return uploadedMediaPathPattern.test(new URL(content).pathname);
  } catch {
    return uploadedMediaPathPattern.test(content);
  }
}

export function registerMessageSocketHandlers(
  io: AppServer,
  socket: AppSocket,
  messageService: MessageService,
  roomService: RoomService,
  userService: UserService,
  typingService: TypingService,
  recordingService: RecordingService,
  presenceService: RoomPresenceService,
  messageRateLimiter: MessageRateLimiter,
): void {
  socket.on('message:send', (payload) => {
    void handleSendMessage(io, socket, messageService, roomService, userService, presenceService, messageRateLimiter, payload);
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
    void handleAudioPlayed(io, socket, messageService, roomService, payload);
  });

  socket.on('room:view-start', (payload) => {
    void handleRoomViewStart(socket, roomService, presenceService, payload);
  });

  socket.on('room:view-stop', (payload) => {
    void handleRoomViewStop(socket, roomService, presenceService, payload);
  });

  socket.on('disconnect', () => {
    handleTypingDisconnect(io, socket, typingService);
    handleRecordingDisconnect(io, socket, recordingService);
    const userId = socket.data.userId;
    if (userId) {
      presenceService.removeUserEverywhere(userId);
    }
  });
}

async function handleRoomViewStart(
  socket: AppSocket,
  roomService: RoomService,
  presenceService: RoomPresenceService,
  payload: unknown,
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  try {
    const { roomId } = roomIdPayloadSchema.parse(payload);
    const room = await roomService.getRoomById(roomId);
    if (!room || !roomService.isParticipant(room, userId)) {
      return;
    }
    presenceService.view(roomId, userId);
  } catch {
    return;
  }
}

async function handleRoomViewStop(
  socket: AppSocket,
  roomService: RoomService,
  presenceService: RoomPresenceService,
  payload: unknown,
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  try {
    const { roomId } = roomIdPayloadSchema.parse(payload);
    const room = await roomService.getRoomById(roomId);
    if (!room || !roomService.isParticipant(room, userId)) {
      return;
    }
    presenceService.leave(roomId, userId);
  } catch {
    return;
  }
}

async function handleSendMessage(
  io: AppServer,
  socket: AppSocket,
  messageService: MessageService,
  roomService: RoomService,
  userService: UserService,
  presenceService: RoomPresenceService,
  messageRateLimiter: MessageRateLimiter,
  payload: unknown,
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { message: 'Usuário não autenticado.' });
    return;
  }

  let clientTempId: string | undefined;

  if (messageRateLimiter.isBlocked(userId)) {
    socket.emit('error', { message: 'Você está enviando mensagens muito rápido. Aguarde um instante.' });
    return;
  }
  messageRateLimiter.registerSend(userId);

  try {
    const parsed = sendMessagePayloadSchema.parse(payload);
    const { roomId, content, type, duration, replyToMessageId, fileMeta, mentionedUserIds: clientMentionedUserIds } = parsed;
    clientTempId = parsed.clientTempId;

    if (type !== 'text' && !isUploadedMediaUrl(content)) {
      socket.emit('error', { message: 'Conteúdo de mídia inválido.', clientTempId });
      return;
    }

    const room = await roomService.getRoomById(roomId);

    if (!room || !roomService.isParticipant(room, userId)) {
      socket.emit('error', { message: 'Sala não encontrada.', clientTempId });
      return;
    }

    if (roomService.isBlocked(room, userId)) {
      socket.emit('error', {
        message: 'Você não pode enviar mensagens nesta conversa devido a bloqueios.',
        clientTempId,
      });
      return;
    }

    const newlyVisibleUserIds = roomService.getNewlyVisibleParticipants(room, userId);

    let mentionedUserIds: string[] = [];
    if (room.type === 'group') {
      if (clientMentionedUserIds) {
        mentionedUserIds = clientMentionedUserIds.filter((id) => room.participants.includes(id));
      } else if (type === 'text') {
        const participantRecords = await Promise.all(room.participants.map((id) => userService.getUser(id)));
        const participants = participantRecords
          .filter((participant): participant is NonNullable<typeof participant> => participant !== null)
          .map((participant) => ({ id: participant.id, nickname: participant.nickname }));
        mentionedUserIds = parseMentionedUserIds(content, participants);
      }
    }

    const message = await messageService.sendMessage({
      roomId,
      senderId: userId,
      content,
      type,
      duration,
      replyToMessageId,
      participantIds: room.participants,
      viewingUserIds: presenceService.getViewers(roomId),
      mentionedUserIds,
      fileMeta,
    });
    const reactivatedBefore = new Date(new Date(message.timestamp).getTime() - 1000).toISOString();
    const updatedRoom = (await roomService.makeVisibleForAll(room, reactivatedBefore)) ?? room;

    const view = await messageService.toView(message);
    io.to(roomId).emit('message:new', clientTempId ? { ...view, clientTempId } : view);

    if (newlyVisibleUserIds.length > 0) {
      const rawMessages = await messageService.getRoomMessages(roomId);

      for (const newlyVisibleUserId of newlyVisibleUserIds) {
        const recipient = await userService.getUser(newlyVisibleUserId);
        if (!recipient?.socketId) {
          continue;
        }

        const summary = await roomService.buildSummary(updatedRoom, newlyVisibleUserId);
        const visibleMessages = roomService.filterMessagesForUser(updatedRoom, rawMessages, newlyVisibleUserId);
        const page = visibleMessages.slice(-INITIAL_MESSAGES_LIMIT);
        const messages = await messageService.toViews(page);
        io.to(recipient.socketId).emit('room:new', { room: summary, messages });
      }
    }
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error), clientTempId });
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
    const { roomId, before, limit } = getMessagesPayloadSchema.parse(payload);
    const room = await roomService.getRoomById(roomId);

    if (!room || !roomService.isParticipant(room, userId)) {
      socket.emit('error', { message: 'Sala não encontrada.' });
      return;
    }

    const after = roomService.getVisibilityCutoff(room, userId);
    const { messages: page, hasMore } = await messageService.getRoomMessagesPage(roomId, { after, before, limit });
    const views = await messageService.toViews(page);
    socket.emit('messages:list', { roomId, messages: views, hasMore });
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
  roomService: RoomService,
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

    const room = await roomService.getRoomById(updated.roomId);
    if (!room || !roomService.isParticipant(room, userId)) {
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
    const { roomId, messageIds } = markReadPayloadSchema.parse(payload);
    const messages = await messageService.markRoomAsRead(roomId, userId, messageIds);
    const messagesForCount = messageIds && messageIds.length > 0 ? await messageService.getRoomMessages(roomId) : messages;
    const unreadCount = messageService.countUnread(messagesForCount, userId);
    const mentionCount = messageService.countUnreadMentions(messagesForCount, userId);

    socket.emit('message:mark-read-done', { roomId, unreadCount, mentionCount });
    socket.to(roomId).emit('message:read-receipt', { roomId, userId });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}
