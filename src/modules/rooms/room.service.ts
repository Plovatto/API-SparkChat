import { randomUUID } from 'node:crypto';
import { AppError } from '../../lib/app-error.js';
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
      throw AppError.of('room.notFound');
    }

    if (room.participants.includes(userId)) {
      return { room, joined: false };
    }

    const added = await this.repository.addParticipant(room.id, userId, new Date().toISOString());
    const current = await this.repository.findById(room.id);
    if (!current || !current.participants.includes(userId)) {
      throw AppError.of('room.notFound');
    }

    return { room: current, joined: added };
  }

  async deleteForUser(roomId: string, userId: string): Promise<RoomRecord | null> {
    const room = await this.repository.findById(roomId);
    if (!room || !room.participants.includes(userId)) {
      return null;
    }

    await this.repository.updateParticipant(roomId, userId, { isVisible: false, deletedAt: new Date().toISOString() });
    return this.repository.findById(roomId);
  }

  async leaveGroup(roomId: string, userId: string): Promise<RoomRecord | null> {
    const room = await this.repository.findById(roomId);
    if (!room || room.type !== 'group' || !room.participants.includes(userId)) {
      return null;
    }

    if (!(await this.repository.removeParticipant(roomId, userId))) {
      return null;
    }
    return this.repository.findById(roomId);
  }

  async promoteAdmin(roomId: string, actingUserId: string, targetUserId: string): Promise<RoomRecord | null> {
    const room = await this.repository.findById(roomId);
    if (!room) {
      return null;
    }

    if (!room.admins.includes(actingUserId)) {
      throw AppError.of('room.promoteRequiresAdmin');
    }

    if (!room.participants.includes(targetUserId)) {
      throw AppError.of('room.notMember');
    }

    if (room.admins.includes(targetUserId)) {
      return room;
    }

    if (!(await this.repository.updateParticipant(roomId, targetUserId, { isAdmin: true }))) {
      throw AppError.of('room.notMember');
    }
    return this.repository.findById(roomId);
  }

  async removeMember(roomId: string, actingUserId: string, targetUserId: string): Promise<RoomRecord | null> {
    const room = await this.repository.findById(roomId);
    if (!room) {
      return null;
    }

    if (!room.admins.includes(actingUserId)) {
      throw AppError.of('room.removeRequiresAdmin');
    }

    if (targetUserId === actingUserId) {
      throw AppError.of('room.cannotRemoveSelf');
    }

    if (!room.participants.includes(targetUserId)) {
      throw AppError.of('room.notMember');
    }

    await this.repository.removeParticipant(roomId, targetUserId, { bannedBy: actingUserId, rotateRoomCode: true });
    return this.repository.findById(roomId);
  }

  async blockUser(roomId: string, userId: string, blockedUserId: string): Promise<RoomRecord | null> {
    const room = await this.repository.findById(roomId);
    if (!room) {
      return null;
    }

    if (
      room.type !== 'private' ||
      userId === blockedUserId ||
      !room.participants.includes(userId) ||
      !room.participants.includes(blockedUserId)
    ) {
      return null;
    }

    await this.repository.updateParticipant(roomId, blockedUserId, { blockedByUserId: userId });
    return this.repository.findById(roomId);
  }

  async unblockUser(roomId: string, userId: string, blockedUserId: string): Promise<RoomRecord | null> {
    const room = await this.repository.findById(roomId);
    if (!room) {
      return null;
    }

    if (!room.participants.includes(userId) || room.blockedBy[blockedUserId] !== userId) {
      return null;
    }

    await this.repository.updateParticipant(roomId, blockedUserId, { blockedByUserId: null }, { onlyIfBlockedBy: userId });
    return this.repository.findById(roomId);
  }

  async getContactIds(userId: string): Promise<string[]> {
    const contactIds = await this.repository.findContactIds(userId);
    return contactIds.includes(userId) ? contactIds : [...contactIds, userId];
  }

  findParticipatingRoomIds(userId: string, roomIds: string[]): Promise<Set<string>> {
    return this.repository.findParticipatingRoomIds(userId, roomIds);
  }

  async normalizeMembershipsAndInviteCodes(): Promise<{ purgedParticipants: number; rotatedCodes: number }> {
    const purgedParticipants = await this.repository.purgeBannedParticipants();
    const rotatedCodes = await this.repository.rotateLegacyRoomCodes();
    return { purgedParticipants, rotatedCodes };
  }

  getRoomById(roomId: string): Promise<RoomRecord | null> {
    return this.repository.findById(roomId);
  }

  findPrivateRoomBetween(userId: string, targetUserId: string): Promise<RoomRecord | null> {
    return this.repository.findPrivateRoomBetween(userId, targetUserId);
  }

  async resetVisibilityForUser(room: RoomRecord, userId: string): Promise<RoomRecord | null> {
    await this.repository.updateParticipant(room.id, userId, { reactivatedAt: new Date().toISOString() });
    return this.repository.findById(room.id);
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

    await this.repository.revealToHiddenParticipants(room.id, reactivatedBefore);
    return this.repository.findById(room.id);
  }

  getVisibilityCutoff(room: RoomRecord, userId: string): string | undefined {
    return room.reactivatedAt?.[userId] ?? room.deletedAt[userId] ?? room.joinedAt?.[userId] ?? undefined;
  }

  canSeeMessage(room: RoomRecord, userId: string, timestamp: string): boolean {
    const cutoff = this.getVisibilityCutoff(room, userId);
    return cutoff === undefined || timestamp > cutoff;
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
      throw AppError.of('room.notFound');
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
        currentEpoch: room.currentEpoch ?? 0,
        currentKeyId: room.currentKeyId ?? null,
        rotationRequiredEpoch: room.rotationRequired ?? null,
      };
    });
  }

  private async makeVisible(room: RoomRecord, userId: string): Promise<RoomRecord> {
    await this.repository.updateParticipant(room.id, userId, { isVisible: true, reactivatedAt: new Date().toISOString() });
    return (await this.repository.findById(room.id)) ?? room;
  }
}
