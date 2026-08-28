import { JsonRepository } from '../../database/json-repository.js';
import type { RoomRecord } from './room.types.js';

export class RoomRepository extends JsonRepository<RoomRecord> {
  async findByRoomCode(roomCode: string): Promise<RoomRecord | null> {
    const rooms = await this.findAll();
    const normalized = roomCode.toUpperCase().trim();
    return rooms.find((room) => room.roomCode === normalized) ?? null;
  }

  async findPrivateRoomBetween(userId1: string, userId2: string): Promise<RoomRecord | null> {
    const rooms = await this.findAll();
    return (
      rooms.find(
        (room) =>
          room.type === 'private' &&
          room.participants.includes(userId1) &&
          room.participants.includes(userId2),
      ) ?? null
    );
  }

  async findVisibleForUser(userId: string): Promise<RoomRecord[]> {
    const rooms = await this.findAll();
    return rooms.filter((room) => room.participants.includes(userId) && room.visibleTo.includes(userId));
  }
}
