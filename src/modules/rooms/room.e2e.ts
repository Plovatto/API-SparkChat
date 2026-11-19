import { and, asc, eq, gt, inArray, notExists, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../database/turso-client.js';
import { roomBans, roomKeys, roomParticipants, rooms, users } from '../../database/schema.js';

export interface StoredRoomKey {
  roomId: string;
  keyId: string;
  epoch: number;
  senderId: string;
  sealedKey: string;
}

export interface RoomKeyWrite {
  userId: string;
  sealedKey: string;
}

export type RoomKeyPublishMode = 'generation' | 'share';

export interface RoomKeyPublication {
  mode: RoomKeyPublishMode;
  roomId: string;
  keyId: string;
  epoch: number;
  senderId: string;
  keys: RoomKeyWrite[];
}

export type RoomKeyPublishOutcome = 'generation' | 'share' | 'stale' | 'incomplete' | 'conflict';

export interface RoomKeyState {
  currentEpoch: number;
  currentKeyId: string | null;
  rotationRequired: number | null;
}

export interface RoomRotation {
  roomId: string;
  epoch: number;
}

export interface RoomKeyWithSender extends StoredRoomKey {
  senderPublicKey: string | null;
  senderSigningPublicKey: string | null;
  senderIsMember: boolean;
}

type Executor = Pick<Database, 'select' | 'update' | 'insert'>;

function sameMembers(a: string[], b: string[]): boolean {
  const left = new Set(a);
  return left.size === a.length && a.length === b.length && b.every((id) => left.has(id));
}

export class RoomKeyRepository {
  constructor(private readonly db: Database) {}

  private notBanned(executor: Executor) {
    return notExists(
      executor
        .select({ userId: roomBans.userId })
        .from(roomBans)
        .where(and(eq(roomBans.roomId, roomParticipants.roomId), eq(roomBans.userId, roomParticipants.userId))),
    );
  }

  private async memberIds(executor: Executor, roomId: string): Promise<string[]> {
    const rows = await executor
      .select({ userId: roomParticipants.userId })
      .from(roomParticipants)
      .where(and(eq(roomParticipants.roomId, roomId), this.notBanned(executor)));
    return rows.map((row) => row.userId);
  }

  async getState(roomId: string): Promise<RoomKeyState | null> {
    const [row] = await this.db
      .select({ currentEpoch: rooms.currentEpoch, currentKeyId: rooms.currentKeyId, rotationRequired: rooms.rotationRequired })
      .from(rooms)
      .where(eq(rooms.id, roomId));
    return row ?? null;
  }

  async publish(publication: RoomKeyPublication): Promise<RoomKeyPublishOutcome> {
    const targets = publication.keys.map((key) => key.userId);
    if (targets.length === 0 || new Set(targets).size !== targets.length) {
      return publication.mode === 'generation' ? 'incomplete' : 'conflict';
    }

    const stored = publication.mode === 'generation' ? await this.storeGeneration(publication) : await this.storeShare(publication);
    return stored ? publication.mode : this.explainRejection(publication);
  }

  private memberCondition(roomId: string, userIds: SQL): SQL {
    return sql`(select count(*) from ${roomParticipants} p
      where p.room_id = ${roomId} and p.user_id in ${userIds}
        and not exists (select 1 from ${roomBans} b where b.room_id = p.room_id and b.user_id = p.user_id))`;
  }

  private keyRows(publication: RoomKeyPublication): SQL {
    const createdAt = new Date().toISOString();
    const values = sql.join(
      publication.keys.map((key) => sql`(${key.userId}, ${key.sealedKey})`),
      sql`, `,
    );
    return sql`select ${publication.roomId}, v.column1, ${publication.keyId}, ${publication.epoch}, v.column2, ${publication.senderId}, ${createdAt}
      from (values ${values}) v`;
  }

  private async storeGeneration(publication: RoomKeyPublication): Promise<boolean> {
    const { roomId, keyId, epoch, senderId, keys } = publication;
    const targetIds = sql`(${sql.join(
      keys.map((key) => sql`${key.userId}`),
      sql`, `,
    )})`;
    const advance = this.db.run(sql`
      update ${rooms} set current_epoch = ${epoch}, current_key_id = ${keyId}, rotation_required = null
      where id = ${roomId}
        and current_epoch = ${epoch - 1}
        and (current_epoch = 0 or rotation_required = ${epoch})
        and ${this.memberCondition(roomId, sql`(${senderId})`)} = 1
        and ${this.memberCondition(roomId, targetIds)} = ${keys.length}
        and (select count(*) from ${roomParticipants} p
          where p.room_id = ${roomId}
            and not exists (select 1 from ${roomBans} b where b.room_id = p.room_id and b.user_id = p.user_id)) = ${keys.length}
    `);
    const insert = this.db.run(sql`
      insert into ${roomKeys} (room_id, user_id, key_id, epoch, sealed_key, sender_id, created_at)
      ${this.keyRows(publication)}
      where changes() = 1
    `);

    const [advanced] = await this.db.batch([advance, insert]);
    return advanced.rowsAffected === 1;
  }

  private async storeShare(publication: RoomKeyPublication): Promise<boolean> {
    const { roomId, keyId, epoch, senderId, keys } = publication;
    const targetIds = sql`(${sql.join(
      keys.map((key) => sql`${key.userId}`),
      sql`, `,
    )})`;
    const result = await this.db.run(sql`
      insert into ${roomKeys} (room_id, user_id, key_id, epoch, sealed_key, sender_id, created_at)
      ${this.keyRows(publication)}
      where exists (select 1 from ${rooms} where id = ${roomId} and current_epoch = ${epoch} and current_key_id = ${keyId})
        and ${this.memberCondition(roomId, sql`(${senderId})`)} = 1
        and exists (select 1 from ${roomKeys} k where k.room_id = ${roomId} and k.user_id = ${senderId} and k.key_id = ${keyId})
        and ${this.memberCondition(roomId, targetIds)} = ${keys.length}
        and not exists (select 1 from ${roomKeys} k where k.room_id = ${roomId} and k.key_id = ${keyId} and k.user_id in ${targetIds})
    `);
    return result.rowsAffected === keys.length;
  }

  private async explainRejection(publication: RoomKeyPublication): Promise<RoomKeyPublishOutcome> {
    const [room, memberIds] = await Promise.all([this.getState(publication.roomId), this.memberIds(this.db, publication.roomId)]);
    if (!room || !memberIds.includes(publication.senderId)) {
      return 'stale';
    }

    if (publication.mode === 'share') {
      return publication.epoch === room.currentEpoch && publication.keyId === room.currentKeyId ? 'conflict' : 'stale';
    }

    const isNextGeneration =
      publication.epoch === room.currentEpoch + 1 && (room.currentEpoch === 0 || room.rotationRequired === publication.epoch);
    if (!isNextGeneration) {
      return 'stale';
    }
    return sameMembers(publication.keys.map((key) => key.userId), memberIds) ? 'stale' : 'incomplete';
  }

  async markRotationRequired(roomId: string): Promise<RoomRotation | null> {
    const [row] = await this.db
      .update(rooms)
      .set({ rotationRequired: sql`${rooms.currentEpoch} + 1` })
      .where(and(eq(rooms.id, roomId), gt(rooms.currentEpoch, 0)))
      .returning({ roomId: rooms.id, epoch: rooms.rotationRequired });
    return row?.epoch ? { roomId: row.roomId, epoch: row.epoch } : null;
  }

  async findForUser(roomId: string, userId: string, keyId: string): Promise<RoomKeyWithSender | null> {
    const senderMembership = this.db
      .select({ userId: roomParticipants.userId })
      .from(roomParticipants)
      .where(and(eq(roomParticipants.roomId, roomKeys.roomId), eq(roomParticipants.userId, roomKeys.senderId), this.notBanned(this.db)));

    const [row] = await this.db
      .select({
        roomId: roomKeys.roomId,
        keyId: roomKeys.keyId,
        epoch: roomKeys.epoch,
        senderId: roomKeys.senderId,
        sealedKey: roomKeys.sealedKey,
        senderPublicKey: users.e2ePublicKey,
        senderSigningPublicKey: users.e2eSigningPublicKey,
        senderIsMember: sql<number>`exists ${senderMembership}`,
      })
      .from(roomKeys)
      .leftJoin(users, eq(users.id, roomKeys.senderId))
      .where(and(eq(roomKeys.roomId, roomId), eq(roomKeys.userId, userId), eq(roomKeys.keyId, keyId)));

    return row ? { ...row, senderIsMember: Boolean(row.senderIsMember) } : null;
  }

  async findForParticipantInRooms(roomIds: string[], userId: string): Promise<StoredRoomKey[]> {
    if (roomIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .select({
        roomId: roomKeys.roomId,
        keyId: roomKeys.keyId,
        epoch: roomKeys.epoch,
        senderId: roomKeys.senderId,
        sealedKey: roomKeys.sealedKey,
      })
      .from(roomKeys)
      .innerJoin(roomParticipants, and(eq(roomParticipants.roomId, roomKeys.roomId), eq(roomParticipants.userId, roomKeys.userId)))
      .where(and(eq(roomKeys.userId, userId), inArray(roomKeys.roomId, roomIds), this.notBanned(this.db)))
      .orderBy(asc(roomKeys.epoch));

    const order = new Map(roomIds.map((roomId, index) => [roomId, index]));
    return rows.sort((a, b) => (order.get(a.roomId) ?? 0) - (order.get(b.roomId) ?? 0) || a.epoch - b.epoch);
  }
}
