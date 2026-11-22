import { z } from 'zod';
import { uploadedMediaKeyPrefix } from '../../config/paths.js';
import { registerClientEvents, registerServerEvents } from '../../docs/socket-registry.js';
import { AppError, errorPayload } from '../../lib/app-error.js';
import type { ErrorCode } from '../../lib/error-catalog.js';
import type { Locale } from '../../lib/locale.js';
import type { AppServer, AppSocket } from '../../sockets/events.js';
import { roomIdPayloadSchema } from '../../sockets/payloads.js';
import { extractErrorPayload } from '../../sockets/socket-errors.js';
import { runSocketHandler } from '../../sockets/socket-handler.js';
import { socketLocale } from '../../sockets/socket-locale.js';
import { requireSocketUserId } from '../../sockets/socket-session.js';
import { emitToUser, isUserRoom, joinUserSocketsToRoom, listUserSockets } from '../../sockets/user-sockets.js';
import { LINK_PREVIEW_ENCRYPTED_LIMITS } from '../link-preview/index.js';
import type { RoomRecord, RoomService } from '../rooms/index.js';
import type { UserService } from '../users/index.js';
import { emitMessageUpdate, emitReactionsUpdate } from './message.broadcast.js';
import { readEncryptedFieldKeyId, resolveMessageKeyId } from './message.encrypted-fields.js';
import { parseMentionedUserIds } from './message.mentions.js';
import type { MessageRateLimiter } from './message.rate-limiter.js';
import {
  messageHiddenPayloadSchema,
  messageReactionsUpdatedPayloadSchema,
  messageViewSchema,
  messagesListPayloadSchema,
  newMessagePayloadSchema,
} from './message.schemas.js';
import { isReactableMessage, type MessageService } from './message.service.js';
import type { MessageRecord } from './message.types.js';
import type { RecordingService } from './recording.service.js';
import type { RoomPresenceService } from './room-presence.service.js';
import {
  isActivityHeldByOtherSocket,
  markSocketActivity,
  releaseAllSocketActivity,
  unmarkSocketActivity,
  type SocketActivityKind,
} from './socket-activity.js';
import type { TypingService } from './typing.service.js';

export type OnMessageSentHook = (context: { io: AppServer; room: RoomRecord; message: MessageRecord; locale: Locale }) => void;

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

export type MessageActivityServices = Pick<MessageSocketDeps, 'typingService' | 'recordingService' | 'presenceService'>;

type ActivityKind = Exclude<SocketActivityKind, 'viewing'>;

const activityEvents = {
  typing: 'typing:update',
  recording: 'recording:update',
} as const satisfies Record<ActivityKind, string>;

const ATTACHMENT_KEY_FIELD_MAX_LENGTH = 400;

const fileMetaSchema = z.object({
  name: z.string().trim().min(1).max(740),
  mimeType: z.string().trim().min(1).max(440),
  size: z.number().int().positive(),
  thumbnailUrl: z.string().trim().min(1).max(4000).optional(),
  key: z.string().trim().min(1).max(ATTACHMENT_KEY_FIELD_MAX_LENGTH).optional(),
  thumbnailKey: z.string().trim().min(1).max(ATTACHMENT_KEY_FIELD_MAX_LENGTH).optional(),
  previewKey: z.string().trim().min(1).max(ATTACHMENT_KEY_FIELD_MAX_LENGTH).optional(),
});

const SIGNED_ENVELOPE_MARGIN = 160;

const linkPreviewSchema = z.object({
  url: z.string().trim().min(1).max(LINK_PREVIEW_ENCRYPTED_LIMITS.url + SIGNED_ENVELOPE_MARGIN),
  title: z.string().trim().min(1).max(LINK_PREVIEW_ENCRYPTED_LIMITS.title + SIGNED_ENVELOPE_MARGIN),
  description: z.string().trim().max(LINK_PREVIEW_ENCRYPTED_LIMITS.description + SIGNED_ENVELOPE_MARGIN).nullable(),
  imageUrl: z.string().trim().max(LINK_PREVIEW_ENCRYPTED_LIMITS.imageUrl + SIGNED_ENVELOPE_MARGIN).nullable(),
  siteName: z.string().trim().max(LINK_PREVIEW_ENCRYPTED_LIMITS.siteName + SIGNED_ENVELOPE_MARGIN).nullable(),
});

type SendMessagePayload = z.infer<typeof sendMessagePayloadSchema>;

function attachmentKeyViolation({ type, fileMeta, linkPreview }: Pick<SendMessagePayload, 'type' | 'fileMeta' | 'linkPreview'>): ErrorCode | null {
  if (type === 'text') {
    if (fileMeta && (fileMeta.thumbnailUrl !== undefined || fileMeta.key !== undefined || fileMeta.thumbnailKey !== undefined)) {
      return 'validation.invalidPayload';
    }
    const needsPreviewKey = fileMeta !== undefined || Boolean(linkPreview?.imageUrl);
    return needsPreviewKey && !fileMeta?.previewKey ? 'message.attachmentKeyRequired' : null;
  }
  if (!fileMeta?.key || (fileMeta.thumbnailUrl && !fileMeta.thumbnailKey)) {
    return 'message.attachmentKeyRequired';
  }
  return null;
}

const clientTempIdSchema = z.string().trim().min(1).max(200);

const sendMessagePayloadSchema = z
  .object({
    roomId: z.string().trim().min(1),
    content: z.string().trim().min(1).max(30000),
    type: z.enum(['text', 'image', 'audio', 'file']).default('text'),
    duration: z.number().int().positive().optional(),
    replyToMessageId: z.string().trim().min(1).optional(),
    clientTempId: clientTempIdSchema.optional(),
    messageId: z.string().uuid(),
    fileMeta: fileMetaSchema.optional(),
    mentionedUserIds: z.array(z.string().trim().min(1)).max(50).optional(),
    caption: z.string().trim().max(3340).optional(),
    linkPreview: linkPreviewSchema.optional(),
    attachmentUrls: z.array(z.string().trim().min(1).max(4000)).max(4).optional(),
  })
  .refine((data) => data.type !== 'audio' || typeof data.duration === 'number', {
    message: 'duration é obrigatório para mensagens de áudio.',
    path: ['duration'],
  })
  .refine((data) => data.type === 'text' || data.fileMeta !== undefined, {
    message: 'fileMeta é obrigatório para mensagens com anexo.',
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

export const MESSAGE_BATCH_LIMIT = 100;

const messageIdsSchema = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(MESSAGE_BATCH_LIMIT)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'messageIds não pode ter itens repetidos.' });

const hideMessagesPayloadSchema = z.object({
  messageIds: messageIdsSchema,
});

const deleteMessagesPayloadSchema = z.union([messageIdPayloadSchema, z.object({ messageIds: messageIdsSchema })]);

function readMessageIds(payload: unknown): string[] | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const value = (payload as { messageIds?: unknown }).messageIds;
  return Array.isArray(value) && value.length <= MESSAGE_BATCH_LIMIT && value.every((id) => typeof id === 'string') ? value : undefined;
}

export const REACTION_FIELD_MAX_LENGTH = 400;

const reactPayloadSchema = z.object({
  messageId: z.string().trim().min(1).max(200),
  emoji: z
    .string()
    .max(REACTION_FIELD_MAX_LENGTH)
    .nullable()
    .openapi({ description: 'Emoji cifrado como campo e2e:v2 com a chave atual da sala, ou null para remover a reação' }),
});

registerClientEvents('messages', {
  'message:send': sendMessagePayloadSchema,
  'message:mark-read': markReadPayloadSchema,
  'messages:get': getMessagesPayloadSchema,
  'message:delete': deleteMessagesPayloadSchema,
  'message:hide': hideMessagesPayloadSchema,
  'message:react': reactPayloadSchema,
  'typing:start': roomIdPayloadSchema,
  'typing:stop': roomIdPayloadSchema,
  'recording:start': roomIdPayloadSchema,
  'recording:stop': roomIdPayloadSchema,
  'audio:played': messageIdPayloadSchema,
  'room:view-start': roomIdPayloadSchema,
  'room:view-stop': roomIdPayloadSchema,
});

registerServerEvents(
  'messages',
  [
    'message:new',
    'message:mark-read-done',
    'message:read-receipt',
    'messages:list',
    'message:deleted',
    'message:hidden',
    'message:updated',
    'message:reactions-updated',
    'typing:update',
    'recording:update',
  ],
  {
    'message:new': newMessagePayloadSchema,
    'messages:list': messagesListPayloadSchema,
    'message:updated': messageViewSchema,
    'message:hidden': messageHiddenPayloadSchema,
    'message:reactions-updated': messageReactionsUpdatedPayloadSchema,
  },
);

const uploadedMediaPathPattern = new RegExp(`^/${uploadedMediaKeyPrefix}/(images|audio|files|gifs)/[^/]+$`);

export function isUploadedMediaUrl(content: string): boolean {
  try {
    const url = new URL(content);
    return url.protocol === 'https:' && uploadedMediaPathPattern.test(url.pathname);
  } catch {
    return false;
  }
}

export function registerMessageSocketHandlers(io: AppServer, socket: AppSocket, deps: MessageSocketDeps): void {
  const { typingService, recordingService, presenceService } = deps;

  socket.on('message:send', (payload) => {
    runSocketHandler(socket, 'message:send', () => handleSendMessage(io, socket, deps, payload));
  });

  socket.on('message:mark-read', (payload) => {
    runSocketHandler(socket, 'message:mark-read', () => handleMarkRead(socket, deps, payload));
  });

  socket.on('messages:get', (payload) => {
    runSocketHandler(socket, 'messages:get', () => handleGetMessages(socket, deps, payload));
  });

  socket.on('message:delete', (payload) => {
    runSocketHandler(socket, 'message:delete', () => handleDeleteMessage(io, socket, deps, payload));
  });

  socket.on('message:hide', (payload) => {
    runSocketHandler(socket, 'message:hide', () => handleHideMessages(io, socket, deps, payload));
  });

  socket.on('message:react', (payload) => {
    runSocketHandler(socket, 'message:react', () => handleReact(io, socket, deps, payload));
  });

  socket.on('typing:start', (payload) => {
    runSocketHandler(socket, 'typing:start', () =>
      handleActivityStart(socket, deps, payload, 'typing', (roomId, userId) => typingService.startTyping(roomId, userId)),
    );
  });

  socket.on('typing:stop', (payload) => {
    runSocketHandler(socket, 'typing:stop', () => {
      handleActivityStop(io, socket, payload, 'typing', (roomId, userId) => typingService.stopTyping(roomId, userId));
    });
  });

  socket.on('recording:start', (payload) => {
    runSocketHandler(socket, 'recording:start', () =>
      handleActivityStart(socket, deps, payload, 'recording', (roomId, userId) => recordingService.startRecording(roomId, userId)),
    );
  });

  socket.on('recording:stop', (payload) => {
    runSocketHandler(socket, 'recording:stop', () => {
      handleActivityStop(io, socket, payload, 'recording', (roomId, userId) => recordingService.stopRecording(roomId, userId));
    });
  });

  socket.on('audio:played', (payload) => {
    runSocketHandler(socket, 'audio:played', () => handleAudioPlayed(io, socket, deps, payload));
  });

  socket.on('room:view-start', (payload) => {
    runSocketHandler(socket, 'room:view-start', () => handleRoomView(io, socket, deps, payload, 'view'));
  });

  socket.on('room:view-stop', (payload) => {
    runSocketHandler(socket, 'room:view-stop', () => handleRoomView(io, socket, deps, payload, 'leave'));
  });

  socket.on('disconnect', () => {
    runSocketHandler(socket, 'disconnect', () => {
      const userId = socket.data.userId;
      if (!userId) {
        return;
      }

      releaseSocketActivity(io, socket, { typingService, recordingService, presenceService }, userId);
    });
  });
}

export function releaseSocketActivity(io: AppServer, socket: AppSocket, services: MessageActivityServices, userId: string): void {
  const released = releaseAllSocketActivity(io, socket, userId);

  for (const roomId of released.typing) {
    io.to(roomId).emit(activityEvents.typing, { roomId, users: services.typingService.stopTyping(roomId, userId) });
  }

  for (const roomId of released.recording) {
    io.to(roomId).emit(activityEvents.recording, { roomId, users: services.recordingService.stopRecording(roomId, userId) });
  }

  for (const roomId of released.viewing) {
    services.presenceService.leave(roomId, userId);
  }
}

async function handleRoomView(
  io: AppServer,
  socket: AppSocket,
  deps: MessageSocketDeps,
  payload: unknown,
  action: 'view' | 'leave',
): Promise<void> {
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

  if (socket.disconnected || socket.data.userId !== userId) {
    return;
  }

  if (action === 'view') {
    markSocketActivity(socket, 'viewing', roomId);
    deps.presenceService.view(roomId, userId);
    return;
  }

  unmarkSocketActivity(socket, 'viewing', roomId);
  if (!isActivityHeldByOtherSocket(io, socket, userId, 'viewing', roomId)) {
    deps.presenceService.leave(roomId, userId);
  }
}

export function readClientTempId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }

  const parsed = clientTempIdSchema.safeParse((payload as { clientTempId?: unknown }).clientTempId);
  return parsed.success ? parsed.data : undefined;
}

async function handleSendMessage(io: AppServer, socket: AppSocket, deps: MessageSocketDeps, payload: unknown): Promise<void> {
  const clientTempId = readClientTempId(payload);
  const userId = socket.data.userId;
  if (!userId) {
    socket.emit('error', { ...errorPayload('auth.unauthenticated'), clientTempId });
    return;
  }

  const { messageService, roomService, presenceService, messageRateLimiter } = deps;

  if (messageRateLimiter.isBlocked(userId)) {
    socket.emit('error', { ...errorPayload('rateLimit.messages'), clientTempId });
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
      messageId,
      fileMeta,
      caption,
      linkPreview,
      attachmentUrls,
      mentionedUserIds: clientMentionedUserIds,
    } = parsed;

    if (type !== 'text' && !isUploadedMediaUrl(content)) {
      socket.emit('error', { ...errorPayload('message.invalidMedia'), clientTempId });
      return;
    }

    if (fileMeta?.thumbnailUrl && !isUploadedMediaUrl(fileMeta.thumbnailUrl)) {
      socket.emit('error', { ...errorPayload('message.invalidMedia'), clientTempId });
      return;
    }

    const attachmentKeyError = attachmentKeyViolation({ type, fileMeta, linkPreview });
    if (attachmentKeyError) {
      socket.emit('error', { ...errorPayload(attachmentKeyError), clientTempId });
      return;
    }

    const keyId = resolveMessageKeyId({ type, content, caption, fileMeta, linkPreview });
    if (!keyId) {
      socket.emit('error', { ...errorPayload('message.unsupportedEncryption'), clientTempId });
      return;
    }

    const room = await roomService.getRoomById(roomId);

    if (!room || !roomService.isParticipant(room, userId)) {
      socket.emit('error', { ...errorPayload('room.notFound'), clientTempId });
      return;
    }

    if (roomService.isBlocked(room, userId)) {
      socket.emit('error', { ...errorPayload('message.blocked'), clientTempId });
      return;
    }

    if (room.rotationRequired !== undefined || room.currentKeyId !== keyId) {
      socket.emit('error', { ...errorPayload('message.staleRoomKey'), clientTempId });
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
      messageId,
      participantIds: room.participants,
      viewingUserIds: presenceService.getViewers(roomId),
      mentionedUserIds,
      fileMeta,
      caption,
      linkPreview,
      attachmentUrls,
    });
    const reactivatedBefore = new Date(new Date(message.timestamp).getTime() - 1000).toISOString();
    const updatedRoom = (await roomService.makeVisibleForAll(room, reactivatedBefore)) ?? room;

    const view = await messageService.toNewView(message);
    io.to(roomId).emit('message:new', clientTempId ? { ...view, clientTempId } : view);
    deps.onMessageSent?.({ io, room, message, locale: socketLocale(socket) });

    for (const newlyVisibleUserId of newlyVisibleUserIds) {
      if (listUserSockets(io, newlyVisibleUserId).length === 0) {
        continue;
      }

      const after = roomService.getVisibilityCutoff(updatedRoom, newlyVisibleUserId);
      const [summary, { messages: page }] = await Promise.all([
        roomService.buildSummary(updatedRoom, newlyVisibleUserId),
        messageService.getRoomMessagesPage(roomId, { after, limit: INITIAL_MESSAGES_LIMIT, viewerId: newlyVisibleUserId }),
      ]);
      const messages = await messageService.toViews(page);
      await joinUserSocketsToRoom(io, newlyVisibleUserId, roomId);
      emitToUser(io, newlyVisibleUserId).emit('room:new', { room: summary, messages });
    }
  } catch (error) {
    socket.emit('error', { ...extractErrorPayload(error), clientTempId });
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
      socket.emit('error', errorPayload('room.notFound'));
      return;
    }

    const after = roomService.getVisibilityCutoff(room, userId);
    const { messages: page, hasMore } = await messageService.getRoomMessagesPage(roomId, { after, before, limit, viewerId: userId });
    const views = await messageService.toViews(page);
    socket.emit('messages:list', { roomId, messages: views, hasMore });
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}

async function handleDeleteMessage(io: AppServer, socket: AppSocket, deps: MessageSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  const isBatch = readMessageIds(payload) !== undefined;
  let messageIds: string[];
  try {
    const parsed = deleteMessagesPayloadSchema.parse(payload);
    messageIds = 'messageIds' in parsed ? parsed.messageIds : [parsed.messageId];
  } catch (error) {
    socket.emit('error', isBatch ? { ...extractErrorPayload(error), event: 'message:delete', messageIds: readMessageIds(payload) } : extractErrorPayload(error));
    return;
  }

  const failed: string[] = [];
  let firstError: unknown = null;
  for (const messageId of messageIds) {
    try {
      await deleteOneMessage(io, deps, messageId, userId);
    } catch (error) {
      failed.push(messageId);
      firstError ??= error;
    }
  }

  if (failed.length > 0) {
    socket.emit('error', isBatch ? { ...extractErrorPayload(firstError), event: 'message:delete', messageIds: failed } : extractErrorPayload(firstError));
  }
}

async function deleteOneMessage(io: AppServer, deps: MessageSocketDeps, messageId: string, userId: string): Promise<void> {
  const existing = await deps.messageService.getMessage(messageId);
  if (existing) {
    const currentRoom = await deps.roomService.getRoomById(existing.roomId);
    if (!currentRoom || !deps.roomService.isParticipant(currentRoom, userId)) {
      throw AppError.of('message.deleteForbidden');
    }
  }

  const { message: updated, affectedReplies } = await deps.messageService.deleteMessage(messageId, userId);
  io.to(updated.roomId).emit('message:deleted', { messageId, roomId: updated.roomId });

  if (affectedReplies.length === 0) {
    return;
  }

  const [room, views] = await Promise.all([
    deps.roomService.getRoomById(updated.roomId),
    deps.messageService.toViews(affectedReplies),
  ]);
  if (!room) {
    return;
  }

  for (const view of views) {
    emitMessageUpdate(io, deps.roomService, room, view);
  }
}

async function handleHideMessages(io: AppServer, socket: AppSocket, deps: MessageSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  const requestedIds = readMessageIds(payload);
  const fail = (code: ErrorCode) => socket.emit('error', { ...errorPayload(code), event: 'message:hide', messageIds: requestedIds });

  try {
    const { messageIds } = hideMessagesPayloadSchema.parse(payload);
    const records = await deps.messageService.getMessages(messageIds);
    if (records.length !== messageIds.length) {
      fail('message.notFound');
      return;
    }

    const roomIds = [...new Set(records.map((record) => record.roomId))];
    const rooms = await Promise.all(roomIds.map((id) => deps.roomService.getRoomById(id)));
    const roomById = new Map(rooms.flatMap((candidate) => (candidate ? [[candidate.id, candidate] as const] : [])));
    const visible = records.every((record) => {
      const candidate = roomById.get(record.roomId);
      return (
        candidate !== undefined &&
        deps.roomService.isParticipant(candidate, userId) &&
        deps.roomService.canSeeMessage(candidate, userId, record.timestamp)
      );
    });
    if (!visible) {
      fail('message.notFound');
      return;
    }

    const [roomId] = roomIds;
    const room = roomId ? roomById.get(roomId) : undefined;
    if (roomIds.length !== 1 || !roomId || !room) {
      fail('message.hideMixedRooms');
      return;
    }

    await deps.messageService.hideMessagesForUser(userId, messageIds);
    const { lastMessage, unreadCount, mentionCount } = await deps.roomService.buildSummary(room, userId);
    emitToUser(io, userId).emit('message:hidden', { roomId, messageIds, lastMessage, unreadCount, mentionCount });
  } catch (error) {
    socket.emit('error', { ...extractErrorPayload(error), event: 'message:hide', messageIds: requestedIds });
  }
}

function readMessageId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const value = (payload as { messageId?: unknown }).messageId;
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined;
}

async function handleReact(io: AppServer, socket: AppSocket, deps: MessageSocketDeps, payload: unknown): Promise<void> {
  const messageIdHint = readMessageId(payload);
  const fail = (code: ErrorCode): void => {
    socket.emit('error', { ...errorPayload(code), event: 'message:react', ...(messageIdHint ? { messageId: messageIdHint } : {}) });
  };

  const userId = socket.data.userId;
  if (!userId) {
    fail('auth.unauthenticated');
    return;
  }

  const { messageService, roomService } = deps;

  try {
    const parsed = reactPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      fail('validation.invalidPayload');
      return;
    }

    const { messageId, emoji } = parsed.data;
    const keyId = emoji === null ? null : readEncryptedFieldKeyId(emoji);
    if (emoji !== null && !keyId) {
      fail('message.unsupportedEncryption');
      return;
    }

    const message = await messageService.getMessage(messageId);
    const room = message ? await roomService.getRoomById(message.roomId) : null;
    if (!message || !room || !roomService.isParticipant(room, userId) || !roomService.canSeeMessage(room, userId, message.timestamp)) {
      fail('message.notFound');
      return;
    }

    if (!isReactableMessage(message)) {
      fail('message.reactionUnavailable');
      return;
    }

    if (emoji !== null && roomService.isBlocked(room, userId)) {
      fail('message.blocked');
      return;
    }

    if (keyId !== null && (room.rotationRequired !== undefined || room.currentKeyId !== keyId)) {
      fail('message.staleRoomKey');
      return;
    }

    const result = await messageService.reactToMessage(message, userId, emoji);
    emitReactionsUpdate(io, roomService, room, result.message, result.reactions);
  } catch (error) {
    socket.emit('error', { ...extractErrorPayload(error), event: 'message:react', ...(messageIdHint ? { messageId: messageIdHint } : {}) });
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

  const message = await deps.messageService.getMessage(parsed.data.messageId);
  if (!message) {
    return;
  }

  const room = await deps.roomService.getRoomById(message.roomId);
  if (!room || !deps.roomService.isParticipant(room, userId) || !deps.roomService.canSeeMessage(room, userId, message.timestamp)) {
    return;
  }

  const updated = await deps.messageService.markAudioPlayed(message.id, userId);
  if (!updated) {
    return;
  }

  const view = await deps.messageService.toView(updated);
  emitMessageUpdate(io, deps.roomService, room, view);
}

const activityGenerations = new WeakMap<AppSocket, Map<string, number>>();

function activityGenerationKey(kind: ActivityKind, roomId: string): string {
  return `${kind}:${roomId}`;
}

function readActivityGeneration(socket: AppSocket, kind: ActivityKind, roomId: string): number {
  return activityGenerations.get(socket)?.get(activityGenerationKey(kind, roomId)) ?? 0;
}

function bumpActivityGeneration(socket: AppSocket, kind: ActivityKind, roomId: string): void {
  const generations = activityGenerations.get(socket) ?? new Map<string, number>();
  const key = activityGenerationKey(kind, roomId);
  generations.set(key, (generations.get(key) ?? 0) + 1);
  activityGenerations.set(socket, generations);
}

function readActivityRoomId(socket: AppSocket, payload: unknown): string | null {
  const parsed = roomIdPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }

  const { roomId } = parsed.data;
  if (isUserRoom(roomId) || !socket.rooms.has(roomId)) {
    return null;
  }
  return roomId;
}

async function handleActivityStart(
  socket: AppSocket,
  deps: MessageSocketDeps,
  payload: unknown,
  kind: ActivityKind,
  apply: (roomId: string, userId: string) => string[],
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  const roomId = readActivityRoomId(socket, payload);
  if (!roomId) {
    return;
  }

  const generation = readActivityGeneration(socket, kind, roomId);
  const room = await deps.roomService.getRoomById(roomId);
  if (!room || deps.roomService.isBlocked(room, userId)) {
    return;
  }

  const stillCurrent =
    socket.connected && socket.data.userId === userId && socket.rooms.has(roomId) && readActivityGeneration(socket, kind, roomId) === generation;
  if (!stillCurrent) {
    return;
  }

  markSocketActivity(socket, kind, roomId);
  const users = apply(roomId, userId);
  socket.to(roomId).emit(activityEvents[kind], { roomId, users });
}

function handleActivityStop(
  io: AppServer,
  socket: AppSocket,
  payload: unknown,
  kind: ActivityKind,
  apply: (roomId: string, userId: string) => string[],
): void {
  const userId = socket.data.userId;
  if (!userId) {
    return;
  }

  const roomId = readActivityRoomId(socket, payload);
  if (!roomId) {
    return;
  }

  bumpActivityGeneration(socket, kind, roomId);
  unmarkSocketActivity(socket, kind, roomId);
  if (isActivityHeldByOtherSocket(io, socket, userId, kind, roomId)) {
    return;
  }

  const users = apply(roomId, userId);
  socket.to(roomId).emit(activityEvents[kind], { roomId, users });
}

async function handleMarkRead(socket: AppSocket, deps: MessageSocketDeps, payload: unknown): Promise<void> {
  const userId = requireSocketUserId(socket);
  if (!userId) {
    return;
  }

  const { messageService, roomService } = deps;

  try {
    const { roomId, messageIds } = markReadPayloadSchema.parse(payload);
    const room = await roomService.getRoomById(roomId);
    if (!room || !roomService.isParticipant(room, userId)) {
      socket.emit('error', errorPayload('room.notFound'));
      return;
    }

    const after = roomService.getVisibilityCutoff(room, userId);
    await messageService.markRoomAsRead(roomId, userId, messageIds, after);
    const { unreadCount, mentionCount } = await messageService.countUnreadForUser(roomId, userId, after);

    socket.emit('message:mark-read-done', { roomId, unreadCount, mentionCount });
    if (!roomService.isBlocked(room, userId)) {
      socket.to(roomId).emit('message:read-receipt', { roomId, userId });
    }
  } catch (error) {
    socket.emit('error', extractErrorPayload(error));
  }
}
