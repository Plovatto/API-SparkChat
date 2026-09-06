import { randomUUID } from 'node:crypto';
import type { MessageRecord, MessageService } from '../messages/index.js';
import type { UserRecord, UserService } from '../users/index.js';
import { generateRoomCode } from './room.codes.js';
import type { RoomRepository } from './room.repository.js';
import type { RoomParticipant, RoomRecord, RoomSummary } from './room.types.js';

export interface JoinByCodeResult {
  room: RoomRecord;
  joined: boolean;
}

function toParticipant(user: UserRecord, isAdmin: boolean): RoomParticipant {
  return {
    id: user.id,
    nickname: user.nickname,
    avatar: user.avatar,
    status: user.status,
    statusText: user.statusText,
    lastSeen: user.lastSeen,
    isAdmin,
  };
}

function toParticipants(room: RoomRecord, usersById: Map<string, UserRecord>): RoomParticipant[] {
  const admins = new Set(room.admins);
  return room.participants
    .map((id) => usersById.get(id))
    .filter((user): user is UserRecord => user !== undefined)
    .map((user) => toParticipant(user, admins.has(user.id)));
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
      return existing.visibleTo.includes(userId) ? existing : this.makeVisible(existing, userId);
    }

    const room: RoomRecord = {
      id: randomUUID(),
      type: 'private',
      participants: [userId, targetUserId],
      admins: [],
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
      admins: [creatorId],
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
    if (!room || !room.participants.includes(userId)) {
      return null;
    }

    const visibleTo = room.visibleTo.filter((id) => id !== userId);
    const deletedAt = { ...room.deletedAt, [userId]: new Date().toISOString() };

    return this.repository.update(roomId, { visibleTo, deletedAt });
  }

  async leaveGroup(roomId: string, userId: string): Promise<RoomRecord | null> {
    const room = await this.repository.findById(roomId);
    if (!room || !room.participants.includes(userId)) {
      return null;
    }

    const participants = room.participants.filter((id) => id !== userId);
    const visibleTo = room.visibleTo.filter((id) => id !== userId);
    const admins = room.admins.filter((id) => id !== userId);

    return this.repository.update(roomId, { participants, visibleTo, admins });
  }

  async promoteAdmin(roomId: string, actingUserId: string, targetUserId: string): Promise<RoomRecord | null> {
    const room = await this.repository.findById(roomId);
    if (!room) {
      return null;
    }

    if (!room.admins.includes(actingUserId)) {
      throw new Error('Apenas administradores podem promover outros membros.');
    }

    if (!room.participants.includes(targetUserId)) {
      throw new Error('Usuário não faz parte do grupo.');
    }

    if (room.admins.includes(targetUserId)) {
      return room;
    }

    return this.repository.update(roomId, { admins: [...room.admins, targetUserId] });
  }

  async removeMember(roomId: string, actingUserId: string, targetUserId: string): Promise<RoomRecord | null> {
    const room = await this.repository.findById(roomId);
    if (!room) {
      return null;
    }

    if (!room.admins.includes(actingUserId)) {
      throw new Error('Apenas administradores podem remover membros.');
    }

    if (targetUserId === actingUserId) {
      throw new Error('Use a opção de sair do grupo para se remover.');
    }

    if (!room.participants.includes(targetUserId)) {
      throw new Error('Usuário não faz parte do grupo.');
    }

    const participants = room.participants.filter((id) => id !== targetUserId);
    const visibleTo = room.visibleTo.filter((id) => id !== targetUserId);
    const admins = room.admins.filter((id) => id !== targetUserId);

    return this.repository.update(roomId, { participants, visibleTo, admins });
  }

  async blockUser(roomId: string, userId: string, blockedUserId: string): Promise<RoomRecord | null> {
    const room = await this.repository.findById(roomId);
    if (!room) {
      return null;
    }

    if (userId === blockedUserId || !room.participants.includes(userId) || !room.participants.includes(blockedUserId)) {
      return null;
    }

    const blockedBy = { ...room.blockedBy, [blockedUserId]: userId };
    return this.repository.update(roomId, { blockedBy });
  }

  async unblockUser(roomId: string, userId: string, blockedUserId: string): Promise<RoomRecord | null> {
    const room = await this.repository.findById(roomId);
    if (!room) {
      return null;
    }

    if (!room.participants.includes(userId) || room.blockedBy[blockedUserId] !== userId) {
      return null;
    }

    const blockedBy = { ...room.blockedBy };
    delete blockedBy[blockedUserId];
    return this.repository.update(roomId, { blockedBy });
  }

  getRoomById(roomId: string): Promise<RoomRecord | null> {
    return this.repository.findById(roomId);
  }

  findPrivateRoomBetween(userId: string, targetUserId: string): Promise<RoomRecord | null> {
    return this.repository.findPrivateRoomBetween(userId, targetUserId);
  }

  async resetVisibilityForUser(room: RoomRecord, userId: string): Promise<RoomRecord | null> {
    const reactivatedAt = { ...room.reactivatedAt, [userId]: new Date().toISOString() };
    return this.repository.update(room.id, { reactivatedAt });
  }

  isBlocked(room: RoomRecord, userId: string): boolean {
    if (room.blockedBy[userId]) {
      return true;
    }

    return Object.values(room.blockedBy).includes(userId);
  }

  isParticipant(room: RoomRecord, userId: string): boolean {
    return room.participants.includes(userId);
  }

  getNewlyVisibleParticipants(room: RoomRecord, excludingUserId: string): string[] {
    return room.participants.filter((id) => id !== excludingUserId && !room.visibleTo.includes(id));
  }

  async makeVisibleForAll(room: RoomRecord, reactivatedBefore: string): Promise<RoomRecord | null> {
    const missing = room.participants.filter((id) => !room.visibleTo.includes(id));
    if (missing.length === 0) {
      return room;
    }

    const reactivatedAt = { ...room.reactivatedAt };
    for (const id of missing) {
      reactivatedAt[id] = reactivatedBefore;
    }

    return this.repository.update(room.id, { visibleTo: [...room.visibleTo, ...missing], reactivatedAt });
  }

  getVisibilityCutoff(room: RoomRecord, userId: string): string | undefined {
    return room.reactivatedAt?.[userId] ?? room.deletedAt[userId] ?? room.joinedAt?.[userId] ?? undefined;
  }

  filterMessagesForUser(room: RoomRecord, messages: MessageRecord[], userId: string): MessageRecord[] {
    const cutoff = this.getVisibilityCutoff(room, userId);
    return cutoff ? messages.filter((message) => message.timestamp > cutoff) : messages;
  }

  getVisibleRoomsForUser(userId: string): Promise<RoomRecord[]> {
    return this.repository.findVisibleForUser(userId);
  }

  async listSummariesForUser(userId: string): Promise<RoomSummary[]> {
    const rooms = await this.getVisibleRoomsForUser(userId);
    return this.buildSummaries(rooms, userId);
  }

  async buildParticipantViews(room: RoomRecord): Promise<RoomParticipant[]> {
    const usersById = await this.userService.getUsersByIds(room.participants);
    return toParticipants(room, usersById);
  }

  async buildSummary(room: RoomRecord, viewerId: string): Promise<RoomSummary> {
    const [summary] = await this.buildSummaries([room], viewerId);
    if (!summary) {
      throw new Error('Sala não encontrada.');
    }
    return summary;
  }

  async buildSummaries(rooms: RoomRecord[], viewerId: string): Promise<RoomSummary[]> {
    if (rooms.length === 0) {
      return [];
    }

    const userIds = new Set<string>();
    for (const room of rooms) {
      for (const participantId of room.participants) {
        userIds.add(participantId);
      }
      if (room.createdBy) {
        userIds.add(room.createdBy);
      }
    }

    const [usersById, digests] = await Promise.all([
      this.userService.getUsersByIds([...userIds]),
      this.messageService.getRoomDigests(
        rooms.map((room) => ({ roomId: room.id, after: this.getVisibilityCutoff(room, viewerId) })),
        viewerId,
      ),
    ]);

    const lastMessageRecords = rooms.flatMap((room) => {
      const lastMessage = digests.get(room.id)?.lastMessage;
      return lastMessage ? [lastMessage] : [];
    });
    const lastMessageViews = await this.messageService.toViews(lastMessageRecords);
    const lastMessageViewById = new Map(lastMessageViews.map((view) => [view.id, view]));

    return rooms.map((room) => {
      const digest = digests.get(room.id);
      const creator = room.createdBy ? usersById.get(room.createdBy) : undefined;
      const isBlockedBy = Boolean(room.blockedBy[viewerId]);
      const userBlocked = Object.values(room.blockedBy).includes(viewerId);
      const lastMessage = digest?.lastMessage ? (lastMessageViewById.get(digest.lastMessage.id) ?? null) : null;

      return {
        id: room.id,
        type: room.type,
        name: room.name,
        roomCode: room.roomCode,
        createdBy: creator?.nickname,
        creatorId: room.createdBy,
        participants: toParticipants(room, usersById),
        lastMessage,
        unreadCount: digest?.unreadCount ?? 0,
        mentionCount: digest?.mentionCount ?? 0,
        blockedBy: room.blockedBy,
        isBlockedBy,
        userBlocked,
        isMutuallyBlocked: isBlockedBy && userBlocked,
      };
    });
  }

  private async makeVisible(room: RoomRecord, userId: string): Promise<RoomRecord> {
    const visibleTo = room.visibleTo.includes(userId) ? room.visibleTo : [...room.visibleTo, userId];
    const reactivatedAt = { ...room.reactivatedAt, [userId]: new Date().toISOString() };
    const updated = await this.repository.update(room.id, { visibleTo, reactivatedAt });

    return updated ?? room;
  }
}
