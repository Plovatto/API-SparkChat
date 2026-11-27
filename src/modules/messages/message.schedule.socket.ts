import { z } from 'zod';
import { registerClientEvents } from '../../docs/socket-registry.js';
import { errorPayload } from '../../lib/app-error.js';
import type { ErrorCode } from '../../lib/error-catalog.js';
import type { AppServer, AppSocket } from '../../sockets/events.js';
import { idSchema } from '../../sockets/payloads.js';
import { extractErrorPayload } from '../../sockets/socket-errors.js';
import { runSocketHandler } from '../../sockets/socket-handler.js';
import { socketLocale } from '../../sockets/socket-locale.js';
import type { ScheduledMessagesService } from '../assistant/scheduled.service.js';
import type { RoomRecord, RoomService } from '../rooms/index.js';
import { clientTempIdSchema, guardEncryptedSend, readClientTempId } from './message.dispatch.js';
import type { MessageRateLimiter } from './message.rate-limiter.js';

export interface ScheduleSocketDeps {
  roomService: Pick<RoomService, 'getRoomById' | 'isParticipant' | 'isBlocked'>;
  messageRateLimiter: MessageRateLimiter;
  isAssistantRoom: (room: RoomRecord) => boolean;
  scheduledMessages?: Pick<ScheduledMessagesService, 'schedule' | 'cancel'> | undefined;
}

const scheduleMessagePayloadSchema = z.object({
  cardId: z.string().uuid(),
  roomId: idSchema,
  sendAt: z
    .number()
    .int()
    .positive()
    .openapi({ description: 'Instante de envio em milissegundos desde a época; deve ser igual ao sendAt do cartão de confirmação' }),
  messageId: z.string().uuid(),
  content: z.string().trim().min(1).max(30000).openapi({ description: 'Texto cifrado como campo e2e:v2 com a chave atual da sala de destino' }),
  type: z.literal('text'),
  clientTempId: clientTempIdSchema.optional(),
});

const unscheduleMessagePayloadSchema = z.object({
  id: z.string().uuid(),
  clientTempId: clientTempIdSchema.optional(),
});

registerClientEvents('messages', {
  'message:schedule': scheduleMessagePayloadSchema,
  'message:unschedule': unscheduleMessagePayloadSchema,
});

export function registerScheduleSocketHandlers(io: AppServer, socket: AppSocket, deps: ScheduleSocketDeps): void {
  socket.on('message:schedule', (payload) => {
    runSocketHandler(socket, 'message:schedule', () => handleSchedule(io, socket, deps, payload));
  });

  socket.on('message:unschedule', (payload) => {
    runSocketHandler(socket, 'message:unschedule', () => handleUnschedule(socket, deps, payload));
  });
}

function emitError(socket: AppSocket, code: ErrorCode, clientTempId: string | undefined): void {
  socket.emit('error', { ...errorPayload(code), clientTempId });
}

async function handleSchedule(io: AppServer, socket: AppSocket, deps: ScheduleSocketDeps, payload: unknown): Promise<void> {
  const clientTempId = readClientTempId(payload);
  const userId = socket.data.userId;
  if (!userId) {
    emitError(socket, 'auth.unauthenticated', clientTempId);
    return;
  }

  const { messageRateLimiter, roomService, scheduledMessages } = deps;
  if (messageRateLimiter.isBlocked(userId)) {
    emitError(socket, 'rateLimit.messages', clientTempId);
    return;
  }
  messageRateLimiter.registerSend(userId);

  try {
    const parsed = scheduleMessagePayloadSchema.parse(payload);
    if (!scheduledMessages) {
      emitError(socket, 'message.scheduleNotAllowed', clientTempId);
      return;
    }
    const guard = await guardEncryptedSend(roomService, userId, parsed.roomId, { type: 'text', content: parsed.content }, (room) =>
      deps.isAssistantRoom(room) ? 'message.scheduleNotAllowed' : null,
    );
    if (!guard.ok) {
      emitError(socket, guard.code, clientTempId);
      return;
    }

    const result = await scheduledMessages.schedule({
      io,
      userId,
      cardId: parsed.cardId,
      roomId: parsed.roomId,
      sendAt: parsed.sendAt,
      messageId: parsed.messageId,
      content: parsed.content,
      keyId: guard.keyId,
      locale: socketLocale(socket),
    });
    if (!result.ok) {
      emitError(socket, result.error === 'limit' ? 'message.scheduleLimit' : 'message.scheduleNotAllowed', clientTempId);
    }
  } catch (error) {
    socket.emit('error', { ...extractErrorPayload(error), clientTempId });
  }
}

async function handleUnschedule(socket: AppSocket, deps: ScheduleSocketDeps, payload: unknown): Promise<void> {
  const clientTempId = readClientTempId(payload);
  const userId = socket.data.userId;
  if (!userId) {
    emitError(socket, 'auth.unauthenticated', clientTempId);
    return;
  }

  try {
    const { id } = unscheduleMessagePayloadSchema.parse(payload);
    if (!deps.scheduledMessages || !(await deps.scheduledMessages.cancel(userId, id))) {
      emitError(socket, 'message.scheduleNotFound', clientTempId);
    }
  } catch (error) {
    socket.emit('error', { ...extractErrorPayload(error), clientTempId });
  }
}
