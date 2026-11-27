import { logger } from '../../config/logger.js';
import type { AppServer } from '../../sockets/events.js';
import { broadcastSentMessage, type BroadcastDeps } from '../messages/message.dispatch.js';
import type { MessageService } from '../messages/message.service.js';
import type { RoomPresenceService } from '../messages/room-presence.service.js';
import type { RoomService } from '../rooms/index.js';
import type { ScheduledMessage } from './scheduled.service.js';

export type DeliveryOutcome = { kind: 'sent' } | { kind: 'failed'; reason: 'room_unavailable' | 'blocked' | 'stale_room_key' };

export interface ScheduledDeliveryDeps extends Pick<BroadcastDeps, 'onMessageSent'> {
  messageService: Pick<MessageService, 'getMessage' | 'sendMessage' | 'toNewView' | 'getRoomMessagesPage' | 'toViews'>;
  roomService: Pick<
    RoomService,
    'getRoomById' | 'isParticipant' | 'isBlocked' | 'getNewlyVisibleParticipants' | 'makeVisibleForAll' | 'getVisibilityCutoff' | 'buildSummary'
  >;
  presenceService: Pick<RoomPresenceService, 'getViewers'>;
}

export class ScheduledDelivery {
  constructor(private readonly deps: ScheduledDeliveryDeps) {}

  async send(io: AppServer, scheduled: ScheduledMessage): Promise<DeliveryOutcome> {
    const { messageService, roomService, presenceService } = this.deps;
    if (await messageService.getMessage(scheduled.messageId)) {
      return { kind: 'sent' };
    }
    const room = await roomService.getRoomById(scheduled.roomId);
    if (!room || !roomService.isParticipant(room, scheduled.userId)) {
      return { kind: 'failed', reason: 'room_unavailable' };
    }
    if (roomService.isBlocked(room, scheduled.userId)) {
      return { kind: 'failed', reason: 'blocked' };
    }
    if (room.rotationRequired !== undefined || room.currentKeyId !== scheduled.payload.keyId) {
      return { kind: 'failed', reason: 'stale_room_key' };
    }

    const newlyVisibleUserIds = roomService.getNewlyVisibleParticipants(room, scheduled.userId);
    const message = await messageService.sendMessage({
      roomId: room.id,
      senderId: scheduled.userId,
      content: scheduled.payload.content,
      type: scheduled.payload.type,
      messageId: scheduled.messageId,
      participantIds: room.participants,
      viewingUserIds: presenceService.getViewers(room.id),
      mentionedUserIds: [],
    });
    await broadcastSentMessage(io, this.deps, room, message, newlyVisibleUserIds, scheduled.locale).catch((error: unknown) =>
      logger.error({ err: error, scheduledId: scheduled.id }, 'Falha ao transmitir mensagem agendada já enviada'),
    );
    return { kind: 'sent' };
  }
}
