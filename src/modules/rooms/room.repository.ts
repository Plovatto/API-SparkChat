import { and, eq, inArray, isNull, ne, notExists, or, sql, type SQL } from 'drizzle-orm';
import { alias, type SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Database } from '../../database/turso-client.js';
import { roomBans, roomParticipants, rooms } from '../../database/schema.js';
import { generateRoomCode, ROOM_CODE_LENGTH } from './room.codes.js';
import type { RoomRecord } from './room.types.js';

type RoomRow = typeof rooms.$inferSelect;
type ParticipantRow = typeof roomParticipants.$inferSelect;

function toRoomRecord(room: RoomRow, participants: ParticipantRow[]): RoomRecord {
  const blockedBy: Record<string, string> = {};
  const deletedAt: Record<string, string> = {};
  const reactivatedAt: Record<string, string> = {};
  const joinedAt: Record<string, string> = {};

  for (const participant of participants) {
    if (participant.blockedByUserId) {
      blockedBy[participant.userId] = participant.blockedByUserId;
    }
    if (participant.deletedAt) {
      deletedAt[participant.userId] = participant.deletedAt;
    }
    if (participant.reactivatedAt) {
      reactivatedAt[participant.userId] = participant.reactivatedAt;
    }
    if (participant.joinedAt) {
      joinedAt[participant.userId] = participant.joinedAt;
    }
  }

  return {
    id: room.id,
    type: room.type,
    name: room.name ?? undefined,
    roomCode: room.roomCode ?? undefined,
    participants: participants.map((participant) => participant.userId),
    admins: participants.filter((participant) => participant.isAdmin).map((participant) => participant.userId),
    createdBy: room.createdBy ?? undefined,
    createdAt: room.createdAt,
    visibleTo: participants.filter((participant) => participant.isVisible).map((participant) => participant.userId),
    blockedBy,
    deletedAt,
    reactivatedAt,
    joinedAt,
  };
}

const rp2 = alias(roomParticipants, 'rp2');

export interface ParticipantPatch {
  isVisible?: boolean;
  isAdmin?: boolean;
  blockedByUserId?: string | null;
  deletedAt?: string | null;
  reactivatedAt?: string | null;
}

export interface RemoveParticipantOptions {
  bannedBy?: string;
  rotateRoomCode?: boolean;
}

export class RoomRepository {
  constructor(private readonly db: Database) {}

  private notBanned(roomIdColumn: SQLiteColumn, userIdColumn: SQLiteColumn): SQL {
    return notExists(
      this.db
        .select({ userId: roomBans.userId })
        .from(roomBans)
        .where(and(eq(roomBans.roomId, roomIdColumn), eq(roomBans.userId, userIdColumn))),
    );
  }

  async findById(id: string): Promise<RoomRecord | null> {
    const [[room], participants] = await Promise.all([
      this.db.select().from(rooms).where(eq(rooms.id, id)),
      this.getParticipants(id),
    ]);

    return room ? toRoomRecord(room, participants) : null;
  }

  private getParticipants(roomId: string): Promise<ParticipantRow[]> {
    return this.db
      .select()
      .from(roomParticipants)
      .where(and(eq(roomParticipants.roomId, roomId), this.notBanned(roomParticipants.roomId, roomParticipants.userId)))
      .orderBy(sql`rowid`);
  }

  async insert(room: RoomRecord): Promise<RoomRecord> {
    const roomInsert = this.db.insert(rooms).values({
      id: room.id,
      type: room.type,
      name: room.name,
      roomCode: room.roomCode,
      createdBy: room.createdBy,
      createdAt: room.createdAt,
    });

    const participantInserts = room.participants.map((userId) =>
      this.db.insert(roomParticipants).values({
        roomId: room.id,
        userId,
        isVisible: room.visibleTo.includes(userId),
        isAdmin: room.admins.includes(userId),
        blockedByUserId: room.blockedBy[userId] ?? null,
        blockedAt: room.blockedBy[userId] ? room.createdAt : null,
        deletedAt: room.deletedAt[userId] ?? null,
        reactivatedAt: room.reactivatedAt?.[userId] ?? null,
        joinedAt: room.joinedAt?.[userId] ?? null,
      }),
    );

    await this.db.batch([roomInsert, ...participantInserts]);

    return room;
  }

  async addParticipant(roomId: string, userId: string, joinedAt: string): Promise<boolean> {
    const result = await this.db.run(sql`
      insert into ${roomParticipants} (room_id, user_id, is_visible, is_admin, joined_at)
      select ${roomId}, ${userId}, 1, 0, ${joinedAt}
      where exists (select 1 from ${rooms} where id = ${roomId})
        and not exists (select 1 from ${roomBans} where room_id = ${roomId} and user_id = ${userId})
      on conflict do nothing
    `);

    return result.rowsAffected > 0;
  }

  async updateParticipant(
    roomId: string,
    userId: string,
    patch: ParticipantPatch,
    options: { onlyIfBlockedBy?: string } = {},
  ): Promise<boolean> {
    const values: Partial<typeof roomParticipants.$inferInsert> = { ...patch };
    if (patch.blockedByUserId !== undefined) {
      values.blockedAt = patch.blockedByUserId ? new Date().toISOString() : null;
    }

    if (Object.keys(values).length === 0) {
      return false;
    }

    const result = await this.db
      .update(roomParticipants)
      .set(values)
      .where(
        and(
          eq(roomParticipants.roomId, roomId),
          eq(roomParticipants.userId, userId),
          options.onlyIfBlockedBy !== undefined ? eq(roomParticipants.blockedByUserId, options.onlyIfBlockedBy) : undefined,
        ),
      );

    return result.rowsAffected > 0;
  }

  async revealToHiddenParticipants(roomId: string, reactivatedAt: string): Promise<void> {
    await this.db
      .update(roomParticipants)
      .set({ isVisible: true, reactivatedAt })
      .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.isVisible, false)));
  }

  async removeParticipant(roomId: string, userId: string, options: RemoveParticipantOptions = {}): Promise<boolean> {
    const deletion = this.db
      .delete(roomParticipants)
      .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.userId, userId)));
    const clearBlocks = this.db
      .update(roomParticipants)
      .set({ blockedByUserId: null, blockedAt: null })
      .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.blockedByUserId, userId)));
    const ban =
      options.bannedBy !== undefined
        ? [
            this.db
              .insert(roomBans)
              .values({ roomId, userId, bannedBy: options.bannedBy, bannedAt: new Date().toISOString() })
              .onConflictDoNothing({ target: [roomBans.roomId, roomBans.userId] }),
          ]
        : [];
    const rotate = options.rotateRoomCode
      ? [this.db.update(rooms).set({ roomCode: generateRoomCode() }).where(eq(rooms.id, roomId))]
      : [];

    const [deleted] = await this.db.batch([deletion, clearBlocks, ...ban, ...rotate]);
    return deleted.rowsAffected > 0;
  }

  async rotateLegacyRoomCodes(): Promise<number> {
    const legacy = await this.db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.type, 'group'), or(isNull(rooms.roomCode), ne(sql`length(${rooms.roomCode})`, ROOM_CODE_LENGTH))));

    for (const { id } of legacy) {
      await this.db.update(rooms).set({ roomCode: generateRoomCode() }).where(eq(rooms.id, id));
    }

    return legacy.length;
  }

  async purgeBannedParticipants(): Promise<number> {
    const result = await this.db
      .delete(roomParticipants)
      .where(
        sql`exists (select 1 from ${roomBans} where ${roomBans.roomId} = ${roomParticipants.roomId} and ${roomBans.userId} = ${roomParticipants.userId})`,
      );
    return result.rowsAffected;
  }

  async findByRoomCode(roomCode: string): Promise<RoomRecord | null> {
    const normalized = roomCode.toUpperCase().trim();
    const [room] = await this.db.select().from(rooms).where(eq(rooms.roomCode, normalized));
    if (!room) {
      return null;
    }

    return toRoomRecord(room, await this.getParticipants(room.id));
  }

  async findParticipatingRoomIds(userId: string, roomIds: string[]): Promise<Set<string>> {
    if (roomIds.length === 0) {
      return new Set();
    }

    const rows = await this.db
      .select({ roomId: roomParticipants.roomId })
      .from(roomParticipants)
      .where(
        and(
          eq(roomParticipants.userId, userId),
          inArray(roomParticipants.roomId, roomIds),
          this.notBanned(roomParticipants.roomId, roomParticipants.userId),
        ),
      );
    return new Set(rows.map((row) => row.roomId));
  }

  async findContactIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ userId: rp2.userId })
      .from(roomParticipants)
      .innerJoin(rp2, eq(rp2.roomId, roomParticipants.roomId))
      .where(
        and(
          eq(roomParticipants.userId, userId),
          sql`coalesce(${rp2.blockedByUserId}, '') <> ${userId}`,
          sql`coalesce(${roomParticipants.blockedByUserId}, '') <> ${rp2.userId}`,
          this.notBanned(roomParticipants.roomId, roomParticipants.userId),
          this.notBanned(rp2.roomId, rp2.userId),
        ),
      );
    return rows.map((row) => row.userId);
  }

  async findPrivateRoomBetween(userId1: string, userId2: string): Promise<RoomRecord | null> {
    const [result] = await this.db
      .select({ room: rooms })
      .from(rooms)
      .innerJoin(roomParticipants, and(eq(roomParticipants.roomId, rooms.id), eq(roomParticipants.userId, userId1)))
      .innerJoin(rp2, and(eq(rp2.roomId, rooms.id), eq(rp2.userId, userId2)))
      .where(eq(rooms.type, 'private'));

    if (!result) {
      return null;
    }

    return toRoomRecord(result.room, await this.getParticipants(result.room.id));
  }

  async findVisibleForUser(userId: string): Promise<RoomRecord[]> {
    const visibleRooms = await this.db
      .select({ room: rooms })
      .from(rooms)
      .innerJoin(
        roomParticipants,
        and(
          eq(roomParticipants.roomId, rooms.id),
          eq(roomParticipants.userId, userId),
          eq(roomParticipants.isVisible, true),
        ),
      )
      .where(this.notBanned(roomParticipants.roomId, roomParticipants.userId));

    if (visibleRooms.length === 0) {
      return [];
    }

    const roomIds = visibleRooms.map(({ room }) => room.id);
    const participantRows = await this.db
      .select()
      .from(roomParticipants)
      .where(and(inArray(roomParticipants.roomId, roomIds), this.notBanned(roomParticipants.roomId, roomParticipants.userId)))
      .orderBy(sql`rowid`);

    const participantsByRoom = new Map<string, ParticipantRow[]>();
    for (const participant of participantRows) {
      const bucket = participantsByRoom.get(participant.roomId);
      if (bucket) {
        bucket.push(participant);
      } else {
        participantsByRoom.set(participant.roomId, [participant]);
      }
    }

    return visibleRooms.map(({ room }) => toRoomRecord(room, participantsByRoom.get(room.id) ?? []));
  }
}
