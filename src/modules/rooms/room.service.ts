import { randomUUID } from 'node:crypto';
import type { UserRecord, UserService } from '../users/index.js';
import { generateRoomCode } from './room.codes.js';
import type { RoomRepository } from './room.repository.js';
import type { RoomParticipant, RoomRecord, RoomSummary } from './room.types.js';

export class RoomService {
  constructor(
    private readonly repository: RoomRepository,
    private readonly userService: UserService,
  ) {}

  async createPrivateRoom(userId: string, targetUserId: string): Promise<RoomRecord> {
    const existing = await this.repository.findPrivateRoomBetween(userId, targetUserId);
    if (existing) {
      return this.makeVisible(existing, userId);
    }

    const room: RoomRecord = {
      id: randomUUID(),
      type: 'private',
      participants: [userId, targetUserId],
      createdAt: new Date().toISOString(),
      visibleTo: [userId],
      blockedBy: {},
      deletedAt: {},
    };

    return this.repository.insert(room);
  }

  async createGroupRoom(name: string, creatorId: string): Promise<RoomRecord> {
    const now = new Date().toISOString();
    const room: RoomRecord = {
      id: randomUUID(),
      type: 'group',
      name,
      roomCode: generateRoomCode(),
      participants: [creatorId],
      createdBy: creatorId,
      createdAt: now,
      visibleTo: [creatorId],
      blockedBy: {},
      deletedAt: {},
      joinedAt: { [creatorId]: now },
    };

    return this.repository.insert(room);
  }

  getVisibleRoomsForUser(userId: string): Promise<RoomRecord[]> {
    return this.repository.findVisibleForUser(userId);
  }

  async buildSummary(room: RoomRecord, viewerId: string): Promise<RoomSummary> {
    const participantRecords = await Promise.all(room.participants.map((id) => this.userService.getUser(id)));
    const participants = participantRecords.filter((user): user is UserRecord => user !== null).map(toParticipant);

    const creator = room.createdBy ? await this.userService.getUser(room.createdBy) : null;
    const isBlockedBy = Boolean(room.blockedBy[viewerId]);
    const userBlocked = Object.values(room.blockedBy).includes(viewerId);

    return {
      id: room.id,
      type: room.type,
      name: room.name,
      roomCode: room.roomCode,
      createdBy: creator?.nickname,
      creatorId: room.createdBy,
      participants,
      lastMessage: null,
      unreadCount: 0,
      blockedBy: room.blockedBy,
      isBlockedBy,
      userBlocked,
      isMutuallyBlocked: isBlockedBy && userBlocked,
    };
  }

  private async makeVisible(room: RoomRecord, userId: string): Promise<RoomRecord> {
    const visibleTo = room.visibleTo.includes(userId) ? room.visibleTo : [...room.visibleTo, userId];
    const reactivatedAt = { ...room.reactivatedAt, [userId]: new Date().toISOString() };
    const updated = await this.repository.update(room.id, { visibleTo, reactivatedAt });

    return updated ?? room;
  }
}

function toParticipant(user: UserRecord): RoomParticipant {
  return {
    id: user.id,
    nickname: user.nickname,
    avatar: user.avatar,
    status: user.status,
    chatCode: user.chatCode,
    lastSeen: user.lastSeen,
  };
}
