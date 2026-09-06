import { z } from 'zod';
import { uploadedMediaKeyPrefix } from '../../config/paths.js';
import { registerClientEvents, registerServerEvents } from '../../docs/socket-registry.js';
import type { AppServer, AppSocket } from '../../sockets/events.js';
import { roomIdPayloadSchema } from '../../sockets/payloads.js';
import { extractErrorMessage } from '../../sockets/socket-errors.js';
import { requireSocketUserId } from '../../sockets/socket-session.js';
import type { RoomRecord, RoomService } from '../rooms/index.js';
import type { UserService } from '../users/index.js';
import { parseMentionedUserIds } from './message.mentions.js';
import type { MessageRateLimiter } from './message.rate-limiter.js';
import type { MessageService } from './message.service.js';
import type { MessageRecord } from './message.types.js';
import type { RecordingService } from './recording.service.js';
import type { RoomPresenceService } from './room-presence.service.js';
import type { TypingService } from './typing.service.js';

export type OnMessageSentHook = (context: { io: AppServer; room: RoomRecord; message: MessageRecord }) => void;

export interface MessageSocketDeps {
  messageService: MessageService;
  roomService: RoomService;
  userService: UserService;
  typingService: TypingService;
  recordingService: RecordingService;
  presenceService: RoomPresenceService;
  messageRateLimiter: MessageRateLimiter;
  onMessageSent?: OnMessageSentHook;
}

export const INITIAL_MESSAGES_LIMIT = 20;

type ActivityEvent = 'typing:update' | 'recording:update';

const fileMetaSchema = z.object({
  name: z.string().trim().min(1).max(500),
  mimeType: z.string().trim().min(1).max(200),
  size: z.number().int().positive(),
  thumbnailUrl: z.string().trim().min(1).max(4000).optional(),
});

const linkPreviewSchema = z.object({
  url: z.string().trim().min(1).max(4000),
  title: z.string().trim().min(1).max(4000),
  description: z.string().trim().max(8000).nullable(),
  imageUrl: z.string().trim().max(4000).nullable(),
  siteName: z.string().trim().max(1000).nullable(),
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
    caption: z.string().trim().max(3000).optional(),
    linkPreview: linkPreviewSchema.optional(),
  })
  .refine((data) => data.type !== 'audio' || typeof data.duration === 'number', {
    message: 'duration é obrigatório para mensagens de áudio.',
    path: ['duration'],
  })
  .refine((data) => data.type !== 'file' || data.fileMeta !== undefined, {
    message: 'fileMeta é obrigatório para mensagens do tipo file.',
    path: ['fileMeta'],
  });

const markReadPayloadSchema = z.object({
  roomId: z.string().trim().min(1),
  messageIds: z.array(z.string().trim().min(1)).max(100).optional(),
});

const getMessagesPayloadSchema = z.object({
  roomId: z.string().trim().min(1),
  before: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(INITIAL_MESSAGES_LIMIT),
});

const messageIdPayloadSchema = z.object({
  messageId: z.string().trim().min(1),
});

registerClientEvents('messages', {
  'message:send': sendMessagePayloadSchema,
  'message:mark-read': markReadPayloadSchema,
  'messages:get': getMessagesPayloadSchema,
  'message:delete': messageIdPayloadSchema,
  'typing:start': roomIdPayloadSchema,
  'typing:stop': roomIdPayloadSchema,
  'recording:start': roomIdPayloadSchema,
  'recording:stop': roomIdPayloadSchema,
  'audio:played': messageIdPayloadSchema,
  'room:view-start': roomIdPayloadSchema,
  'room:view-stop': roomIdPayloadSchema,
});

registerServerEvents('messages', [
  'message:new',
  'message:mark-read-done',
  'message:read-receipt',
  'messages:list',
  'message:deleted',
  'message:updated',
  'typing:update',
  'recording:update',
]);

const uploadedMediaPathPattern = new RegExp(`^/${uploadedMediaKeyPrefix}/(images|audio|files)/[^/]+$`);

function isUploadedMediaUrl(content: string): boolean {
  try {
    return uploadedMediaPathPattern.test(new URL(content).pathname);
  } catch {
    return uploadedMediaPathPattern.test(content);
  }
}

export function registerMessageSocketHandlers(io: AppServer, socket: AppSocket, deps: MessageSocketDeps): void {
  const { typingService, recordingService, presenceService } = deps;

  socket.on('message:send', (payload) => {
    void handleSendMessage(io, socket, deps, payload);
  });

  socket.on('message:mark-read', (payload) => {
    void handleMarkRead(socket, deps, payload);
  });

  socket.on('messages:get', (payload) => {
    void handleGetMessages(socket, deps, payload);
  });

  socket.on('message:delete', (payload) => {
    void handleDeleteMessage(io, socket, deps, payload);
  });

  socket.on('typing:start', (payload) => {
    handleActivityChange(socket, payload, 'typing:update', (roomId, userId) => typingService.startTyping(roomId, userId));
  });

  socket.on('typing:stop', (payload) => {
    handleActivityChange(socket, payload, 'typing:update', (roomId, userId) => typingService.stopTyping(roomId, userId));
  });

  socket.on('recording:start', (payload) => {
    handleActivityChange(socket, payload, 'recording:update', (roomId, userId) => recordingService.startRecording(roomId, userId));
  });

  socket.on('recording:stop', (payload) => {
    handleActivityChange(socket, payload, 'recording:update', (roomId, userId) => recordingService.stopRecording(roomId, userId));
  });

  socket.on('audio:played', (payload) => {
    void handleAudioPlayed(io, socket, deps, payload);
  });

  socket.on('room:view-start', (payload) => {
    void handleRoomView(socket, deps, payload, 'view');
  });

  socket.on('room:view-stop', (payload) => {
    void handleRoomView(socket, deps, payload, 'leave');
  });

  socket.on('disconnect', () => {
    const userId = socket.data.userId;
    if (!userId) {
      return;
    }

    broadcastActivityRemoval(io, 'typing:update', typingService.removeUserEverywhere(userId));
    broadcastActivityRemoval(io, 'recording:update', recordingService.removeUserEverywhere(userId));
    presenceService.removeUserEverywhere(userId);
  });
}

async function handleRoomView(socket: AppSocket, deps: MessageSocketDeps, payload: unknown, action: 'view' | 'leave'): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  const parsed = roomIdPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return;
  }

  const { roomId } = parsed.data;
  const room = await deps.roomService.getRoomById(roomId);
  if (!room || !deps.roomService.isParticipant(room, userId)) {
    return;
  }

  if (action === 'view') {
    deps.presenceService.view(roomId, userId);
  } else {
    deps.presenceService.leave(roomId, userId);
  }
}

async function handleSendMessage(io: AppServer, socket: AppSocket, deps: MessageSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  const { messageService, roomService, userService, presenceService, messageRateLimiter } = deps;
  let clientTempId: string | undefined;

  if (messageRateLimiter.isBlocked(userId)) {
    socket.emit('error', { message: 'Você está enviando mensagens muito rápido. Aguarde um instante.' });
    return;
  }
  messageRateLimiter.registerSend(userId);

  try {
    const parsed = sendMessagePayloadSchema.parse(payload);
    const {
      roomId,
      content,
      type,
      duration,
      replyToMessageId,
      fileMeta,
      caption,
      linkPreview,
      mentionedUserIds: clientMentionedUserIds,
    } = parsed;
    clientTempId = parsed.clientTempId;

    if (type !== 'text' && !isUploadedMediaUrl(content)) {
      socket.emit('error', { message: 'Conteúdo de mídia inválido.', clientTempId });
      return;
    }

    if (fileMeta?.thumbnailUrl && !isUploadedMediaUrl(fileMeta.thumbnailUrl)) {
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
        const participants = await roomService.buildParticipantViews(room);
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
      caption,
      linkPreview,
    });
    const reactivatedBefore = new Date(new Date(message.timestamp).getTime() - 1000).toISOString();
    const updatedRoom = (await roomService.makeVisibleForAll(room, reactivatedBefore)) ?? room;

    const view = await messageService.toView(message);
    io.to(roomId).emit('message:new', clientTempId ? { ...view, clientTempId } : view);
    deps.onMessageSent?.({ io, room, message });

    if (newlyVisibleUserIds.length > 0) {
      const recipients = await userService.getUsersByIds(newlyVisibleUserIds);

      for (const newlyVisibleUserId of newlyVisibleUserIds) {
        const recipient = recipients.get(newlyVisibleUserId);
        if (!recipient?.socketId) {
          continue;
        }

        const after = roomService.getVisibilityCutoff(updatedRoom, newlyVisibleUserId);
        const [summary, { messages: page }] = await Promise.all([
          roomService.buildSummary(updatedRoom, newlyVisibleUserId),
          messageService.getRoomMessagesPage(roomId, { after, limit: INITIAL_MESSAGES_LIMIT }),
        ]);
        const messages = await messageService.toViews(page);
        io.to(recipient.socketId).emit('room:new', { room: summary, messages });
      }
    }
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error), clientTempId });
  }
}

async function handleGetMessages(socket: AppSocket, deps: MessageSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  const { messageService, roomService } = deps;

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

async function handleDeleteMessage(io: AppServer, socket: AppSocket, deps: MessageSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  try {
    const { messageId } = messageIdPayloadSchema.parse(payload);
    const updated = await deps.messageService.deleteMessage(messageId, userId);
    io.to(updated.roomId).emit('message:deleted', { messageId, roomId: updated.roomId });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}

async function handleAudioPlayed(io: AppServer, socket: AppSocket, deps: MessageSocketDeps, payload: unknown): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  const parsed = messageIdPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return;
  }

  const updated = await deps.messageService.markAudioPlayed(parsed.data.messageId, userId);
  if (!updated) {
    return;
  }

  const room = await deps.roomService.getRoomById(updated.roomId);
  if (!room || !deps.roomService.isParticipant(room, userId)) {
    return;
  }

  const view = await deps.messageService.toView(updated);
  io.to(updated.roomId).emit('message:updated', view);
}

function handleActivityChange(
  socket: AppSocket,
  payload: unknown,
  event: ActivityEvent,
  apply: (roomId: string, userId: string) => string[],
): void {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  const parsed = roomIdPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return;
  }

  const { roomId } = parsed.data;
  const users = apply(roomId, userId);
  socket.to(roomId).emit(event, { roomId, users });
}

function broadcastActivityRemoval(io: AppServer, event: ActivityEvent, updates: { roomId: string; users: string[] }[]): void {
  for (const { roomId, users } of updates) {
    io.to(roomId).emit(event, { roomId, users });
  }
}

async function handleMarkRead(socket: AppSocket, deps: MessageSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  const { messageService } = deps;

  try {
    const { roomId, messageIds } = markReadPayloadSchema.parse(payload);
    await messageService.markRoomAsRead(roomId, userId, messageIds);
    const { unreadCount, mentionCount } = await messageService.countUnreadForUser(roomId, userId);

    socket.emit('message:mark-read-done', { roomId, unreadCount, mentionCount });
    socket.to(roomId).emit('message:read-receipt', { roomId, userId });
  } catch (error) {
    socket.emit('error', { message: extractErrorMessage(error) });
  }
}
