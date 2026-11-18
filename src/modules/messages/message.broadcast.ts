import type { AppServer } from '../../sockets/events.js';
import { userRoom } from '../../sockets/user-sockets.js';
import type { RoomRecord, RoomService } from '../rooms/index.js';
import type { MessageView } from './message.types.js';

export function emitMessageUpdate(io: AppServer, roomService: RoomService, room: RoomRecord, view: MessageView): void {
  const hiddenFrom = room.participants
    .filter((participantId) => !roomService.canSeeMessage(room, participantId, view.timestamp))
    .map(userRoom);
  io.to(room.id).except(hiddenFrom).emit('message:updated', view);
}
