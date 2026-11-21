import type { AppServer } from '../../sockets/events.js';
import { userRoom } from '../../sockets/user-sockets.js';
import type { RoomRecord, RoomService } from '../rooms/index.js';
import type { MessageReaction, MessageView } from './message.types.js';

function toMessageViewers(io: AppServer, roomService: RoomService, room: RoomRecord, timestamp: string) {
  const hiddenFrom = room.participants
    .filter((participantId) => !roomService.canSeeMessage(room, participantId, timestamp))
    .map(userRoom);
  return io.to(room.id).except(hiddenFrom);
}

export function emitMessageUpdate(io: AppServer, roomService: RoomService, room: RoomRecord, view: MessageView): void {
  toMessageViewers(io, roomService, room, view.timestamp).emit('message:updated', view);
}

export function emitReactionsUpdate(
  io: AppServer,
  roomService: RoomService,
  room: RoomRecord,
  message: { id: string; timestamp: string },
  reactions: MessageReaction[],
): void {
  toMessageViewers(io, roomService, room, message.timestamp).emit('message:reactions-updated', {
    roomId: room.id,
    messageId: message.id,
    messageTimestamp: message.timestamp,
    reactions,
  });
}
