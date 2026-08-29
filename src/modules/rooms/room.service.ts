import { randomUUID } from 'node:crypto';
import type { MessageService } from '../messages/index.js';
import type { UserRecord, UserService } from '../users/index.js';
import { generateRoomCode } from './room.codes.js';
import type { RoomRepository } from './room.repository.js';
import type { RoomParticipant, RoomRecord, RoomSummary } from './room.types.js';

export interface JoinByCodeResult {
  room: RoomRecord;
  joined: boolean;
}

export class RoomService {
  constructor(
    private readonly repository: RoomRepository,
    private readonly userService: UserService,
    private readonly messageService: MessageService,
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

  async joinByCode(roomCode: string, userId: string): Promise<JoinByCodeResult> {
    const room = await this.repository.findByRoomCode(roomCode);
    if (!room) {
      throw new Error('Sala não encontrada.');
    }

    if (room.participants.includes(userId)) {
      return { room, joined: false };
    }

    const now = new Date().toISOString();
    const participants = [...room.participants, userId];
    const visibleTo = room.visibleTo.includes(userId) ? room.visibleTo : [...room.visibleTo, userId];
    const joinedAt = { ...room.joinedAt, [userId]: now };

    const updated = await this.repository.update(room.id, { participants, visibleTo, joinedAt });
    if (!updated) {
      throw new Error('Sala não encontrada.');
    }

    return { room: updated, joined: true };
  }

  async deleteForUser(roomId: string, userId: string): Promise<RoomRecord | null> {
    const room = await this.repository.findById(roomId);
    if (!room) {
      return null;
    }

    const visibleTo = room.visibleTo.filter((id) => id !== userId);
    const deletedAt = { ...room.deletedAt, [userId]: new Date().toISOString() };

    return this.repository.update(roomId, { visibleTo, deletedAt });
  }

  async leaveGroup(roomId: string, userId: string): Promise<RoomRecord | null> {
    const room = await this.repository.findById(roomId);
    if (!room) {
      return null;
    }

    const participants = room.participants.filter((id) => id !== userId);
    const visibleTo = room.visibleTo.filter((id) => id !== userId);

    return this.repository.update(roomId, { participants, visibleTo });
  }

  async blockUser(roomId: string, userId: string, blockedUserId: string): Promise<RoomRecord | null> {
    const room = await this.repository.findById(roomId);
    if (!room) {
      return null;
    }

    const blockedBy = { ...room.blockedBy, [blockedUserId]: userId };
    return this.repository.update(roomId, { blockedBy });
  }

  async unblockUser(roomId: string, blockedUserId: string): Promise<RoomRecord | null> {
    const room = await this.repository.findById(roomId);
    if (!room) {
      return null;
    }

    const blockedBy = { ...room.blockedBy };
    delete blockedBy[blockedUserId];
    return this.repository.update(roomId, { blockedBy });
  }

  getRoomById(roomId: string): Promise<RoomRecord | null> {
    return this.repository.findById(roomId);
  }

  isBlocked(room: RoomRecord, userId: string): boolean {
    if (room.blockedBy[userId]) {
      return true;
    }

    return Object.values(room.blockedBy).includes(userId);
  }

  async makeVisibleForAll(room: RoomRecord): Promise<RoomRecord | null> {
    const missing = room.participants.filter((id) => !room.visibleTo.includes(id));
    if (missing.length === 0) {
      return room;
    }

    return this.repository.update(room.id, { visibleTo: [...room.visibleTo, ...missing] });
  }

  getVisibleRoomsForUser(userId: string): Promise<RoomRecord[]> {
    return this.repository.findVisibleForUser(userId);
  }

  async listSummariesForUser(userId: string): Promise<RoomSummary[]> {
    const rooms = await this.getVisibleRoomsForUser(userId);
    return Promise.all(rooms.map((room) => this.buildSummary(room, userId)));
  }

  async buildSummary(room: RoomRecord, viewerId: string): Promise<RoomSummary> {
    const participantRecords = await Promise.all(room.participants.map((id) => this.userService.getUser(id)));
    const participants = participantRecords.filter((user): user is UserRecord => user !== null).map(toParticipant);

    const creator = room.createdBy ? await this.userService.getUser(room.createdBy) : null;
    const isBlockedBy = Boolean(room.blockedBy[viewerId]);
    const userBlocked = Object.values(room.blockedBy).includes(viewerId);

    const messages = await this.messageService.getRoomMessages(room.id);
    const lastMessageRecord = messages.length > 0 ? (messages[messages.length - 1] ?? null) : null;
    const lastMessage = lastMessageRecord ? await this.messageService.toView(lastMessageRecord) : null;
    const unreadCount = this.messageService.countUnread(messages, viewerId);

    return {
      id: room.id,
      type: room.type,
      name: room.name,
      roomCode: room.roomCode,
      createdBy: creator?.nickname,
      creatorId: room.createdBy,
      participants,
      lastMessage,
      unreadCount,
      blockedBy: room.blockedBy,
      isBlockedBy,
      userBlocked,
      isMutuallyBlocked: isBlockedBy && userBlocked,
    };
  }

  toParticipantView(user: UserRecord): RoomParticipant {
    return toParticipant(user);
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
