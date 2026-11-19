import type { AppServer } from '../../sockets/events.js';
import type { InviteProofView } from './room.invites.js';

export interface RoomRotationAnnouncement {
  roomId: string;
  epoch: number;
  memberIds?: string[];
  inviteProofs?: InviteProofView[];
}

export function notifyRoomRotations(io: AppServer, rotations: RoomRotationAnnouncement[]): void {
  for (const rotation of rotations) {
    io.to(rotation.roomId).emit('e2e:rotation-required', rotation);
  }
}
