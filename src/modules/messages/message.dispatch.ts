import { z } from 'zod';
import type { ErrorCode } from '../../lib/error-catalog.js';
import type { Locale } from '../../lib/locale.js';
import type { AppServer } from '../../sockets/events.js';
import { emitToUser, joinUserSocketsToRoom, listUserSockets } from '../../sockets/user-sockets.js';
import type { RoomRecord, RoomService } from '../rooms/index.js';
import { resolveMessageKeyId, type EncryptedMessageFields } from './message.encrypted-fields.js';
import type { MessageService } from './message.service.js';
import type { MessageRecord } from './message.types.js';

export const INITIAL_MESSAGES_LIMIT = 20;

export const clientTempIdSchema = z.string().trim().min(1).max(200);

export function readClientTempId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }

  const parsed = clientTempIdSchema.safeParse((payload as { clientTempId?: unknown }).clientTempId);
  return parsed.success ? parsed.data : undefined;
}

export type OnMessageSentHook = (context: { io: AppServer; room: RoomRecord; message: MessageRecord; locale: Locale }) => void;

export type SendGuardResult = { ok: true; room: RoomRecord; keyId: string } | { ok: false; code: ErrorCode };

export async function guardEncryptedSend(
  roomService: Pick<RoomService, 'getRoomById' | 'isParticipant' | 'isBlocked'>,
  userId: string,
  roomId: string,
  fields: EncryptedMessageFields,
  extraCheck?: (room: RoomRecord) => ErrorCode | null,
): Promise<SendGuardResult> {
  const keyId = resolveMessageKeyId(fields);
  if (!keyId) {
    return { ok: false, code: 'message.unsupportedEncryption' };
  }

  const room = await roomService.getRoomById(roomId);
  if (!room || !roomService.isParticipant(room, userId)) {
    return { ok: false, code: 'room.notFound' };
  }

  if (roomService.isBlocked(room, userId)) {
    return { ok: false, code: 'message.blocked' };
  }

  const extra = extraCheck?.(room);
  if (extra) {
    return { ok: false, code: extra };
  }

  if (room.rotationRequired !== undefined || room.currentKeyId !== keyId) {
    return { ok: false, code: 'message.staleRoomKey' };
  }

  return { ok: true, room, keyId };
}

export interface BroadcastDeps {
  messageService: Pick<MessageService, 'toNewView' | 'getRoomMessagesPage' | 'toViews'>;
  roomService: Pick<RoomService, 'makeVisibleForAll' | 'getVisibilityCutoff' | 'buildSummary'>;
  onMessageSent?: OnMessageSentHook | undefined;
}

export async function broadcastSentMessage(
  io: AppServer,
  deps: BroadcastDeps,
  room: RoomRecord,
  message: MessageRecord,
  newlyVisibleUserIds: string[],
  locale: Locale,
  clientTempId?: string,
): Promise<void> {
  const { messageService, roomService } = deps;
  const reactivatedBefore = new Date(new Date(message.timestamp).getTime() - 1000).toISOString();
  const updatedRoom = (await roomService.makeVisibleForAll(room, reactivatedBefore)) ?? room;

  const view = await messageService.toNewView(message);
  io.to(room.id).emit('message:new', clientTempId ? { ...view, clientTempId } : view);
  deps.onMessageSent?.({ io, room, message, locale });

  for (const newlyVisibleUserId of newlyVisibleUserIds) {
    if (listUserSockets(io, newlyVisibleUserId).length === 0) {
      continue;
    }

    const after = roomService.getVisibilityCutoff(updatedRoom, newlyVisibleUserId);
    const [summary, { messages: page }] = await Promise.all([
      roomService.buildSummary(updatedRoom, newlyVisibleUserId),
      messageService.getRoomMessagesPage(room.id, { after, limit: INITIAL_MESSAGES_LIMIT, viewerId: newlyVisibleUserId }),
    ]);
    const messages = await messageService.toViews(page);
    await joinUserSocketsToRoom(io, newlyVisibleUserId, room.id);
    emitToUser(io, newlyVisibleUserId).emit('room:new', { room: summary, messages });
  }
}
