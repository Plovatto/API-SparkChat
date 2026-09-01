import { and, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Database } from '../../database/turso-client.js';
import { roomParticipants, rooms } from '../../database/schema.js';
import type { RoomRecord, RoomType } from './room.types.js';

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
    type: room.type as RoomType,
    name: room.name ?? undefined,
    roomCode: room.roomCode ?? undefined,
    participants: participants.map((participant) => participant.userId),
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

export class RoomRepository {
  constructor(private readonly db: Database) {}

  async findAll(): Promise<RoomRecord[]> {
    const [roomRows, participantRows] = await Promise.all([
      this.db.select().from(rooms),
      this.db.select().from(roomParticipants).orderBy(sql`rowid`),
    ]);
    return roomRows.map((room) => toRoomRecord(room, participantRows.filter((p) => p.roomId === room.id)));
  }

  async findById(id: string): Promise<RoomRecord | null> {
    const [[room], participants] = await Promise.all([
      this.db.select().from(rooms).where(eq(rooms.id, id)),
      this.getParticipants(id),
    ]);

    return room ? toRoomRecord(room, participants) : null;
  }

  private getParticipants(roomId: string): Promise<ParticipantRow[]> {
    return this.db.select().from(roomParticipants).where(eq(roomParticipants.roomId, roomId)).orderBy(sql`rowid`);
  }

  async insert(room: RoomRecord): Promise<RoomRecord> {
    await this.db.insert(rooms).values({
      id: room.id,
      type: room.type,
      name: room.name,
      roomCode: room.roomCode,
      createdBy: room.createdBy,
      createdAt: room.createdAt,
    });

    await this.syncParticipants(room);

    return room;
  }

  async update(id: string, patch: Partial<RoomRecord>): Promise<RoomRecord | null> {
    const current = await this.findById(id);
    if (!current) {
      return null;
    }

    const merged: RoomRecord = { ...current, ...patch };
    const { id: _id, participants, visibleTo, blockedBy, deletedAt, reactivatedAt, joinedAt, ...columns } = patch;

    const touchesParticipants =
      participants !== undefined ||
      visibleTo !== undefined ||
      blockedBy !== undefined ||
      deletedAt !== undefined ||
      reactivatedAt !== undefined ||
      joinedAt !== undefined;

    await Promise.all([
      Object.keys(columns).length > 0
        ? this.db.update(rooms).set(columns).where(eq(rooms.id, id))
        : Promise.resolve(),
      touchesParticipants ? this.syncParticipants(merged) : Promise.resolve(),
    ]);

    return merged;
  }

  async findByRoomCode(roomCode: string): Promise<RoomRecord | null> {
    const normalized = roomCode.toUpperCase().trim();
    const [room] = await this.db.select().from(rooms).where(eq(rooms.roomCode, normalized));
    if (!room) {
      return null;
    }

    return toRoomRecord(room, await this.getParticipants(room.id));
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
      );

    if (visibleRooms.length === 0) {
      return [];
    }

    const roomIds = visibleRooms.map(({ room }) => room.id);
    const participantRows = await this.db
      .select()
      .from(roomParticipants)
      .where(inArray(roomParticipants.roomId, roomIds))
      .orderBy(sql`rowid`);

    return visibleRooms.map(({ room }) =>
      toRoomRecord(
        room,
        participantRows.filter((participant) => participant.roomId === room.id),
      ),
    );
  }

  private async syncParticipants(room: RoomRecord): Promise<void> {
    const existing = await this.db.select().from(roomParticipants).where(eq(roomParticipants.roomId, room.id));
    const existingById = new Map(existing.map((row) => [row.userId, row]));
    const participantIds = new Set(room.participants);

    const deletions = existing
      .filter((row) => !participantIds.has(row.userId))
      .map((row) =>
        this.db
          .delete(roomParticipants)
          .where(and(eq(roomParticipants.roomId, room.id), eq(roomParticipants.userId, row.userId))),
      );

    const upserts = [...participantIds].map((userId) => {
      const previous = existingById.get(userId);
      const blockedByUserId = room.blockedBy[userId] ?? null;
      const blockedAt = blockedByUserId
        ? previous?.blockedByUserId === blockedByUserId
          ? previous.blockedAt
          : new Date().toISOString()
        : null;

      const values = {
        roomId: room.id,
        userId,
        isVisible: room.visibleTo.includes(userId),
        blockedByUserId,
        blockedAt,
        deletedAt: room.deletedAt[userId] ?? null,
        reactivatedAt: room.reactivatedAt?.[userId] ?? null,
        joinedAt: room.joinedAt?.[userId] ?? null,
      };

      return previous
        ? this.db
            .update(roomParticipants)
            .set(values)
            .where(and(eq(roomParticipants.roomId, room.id), eq(roomParticipants.userId, userId)))
        : this.db.insert(roomParticipants).values(values);
    });

    await Promise.all([...deletions, ...upserts]);
  }
}
