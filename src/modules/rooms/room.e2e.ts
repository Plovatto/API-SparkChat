import { and, asc, eq, gt, inArray, notExists, sql } from 'drizzle-orm';
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
  private publishQueue: Promise<unknown> = Promise.resolve();

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

  publish(publication: RoomKeyPublication): Promise<RoomKeyPublishOutcome> {
    const run = this.publishQueue.then(() => this.publishInTransaction(publication));
    this.publishQueue = run.catch(() => undefined);
    return run;
  }

  private publishInTransaction(publication: RoomKeyPublication): Promise<RoomKeyPublishOutcome> {
    return this.db.transaction(async (tx) => {
      const [room] = await tx
        .select({ currentEpoch: rooms.currentEpoch, currentKeyId: rooms.currentKeyId, rotationRequired: rooms.rotationRequired })
        .from(rooms)
        .where(eq(rooms.id, publication.roomId));
      if (!room) {
        return 'stale';
      }

      const createdAt = new Date().toISOString();
      const insertAll = async () => {
        for (const key of publication.keys) {
          await tx.insert(roomKeys).values({
            roomId: publication.roomId,
            userId: key.userId,
            keyId: publication.keyId,
            epoch: publication.epoch,
            sealedKey: key.sealedKey,
            senderId: publication.senderId,
            createdAt,
          });
        }
      };

      const isNextGeneration =
        publication.epoch === room.currentEpoch + 1 && (room.currentEpoch === 0 || room.rotationRequired === publication.epoch);
      if (publication.mode === 'generation') {
        if (!isNextGeneration) {
          return 'stale';
        }
        const members = await this.memberIds(tx, publication.roomId);
        if (!sameMembers(publication.keys.map((key) => key.userId), members)) {
          return 'incomplete';
        }
        const advanced = await tx
          .update(rooms)
          .set({ currentEpoch: publication.epoch, currentKeyId: publication.keyId, rotationRequired: null })
          .where(and(eq(rooms.id, publication.roomId), eq(rooms.currentEpoch, room.currentEpoch)));
        if (advanced.rowsAffected === 0) {
          return 'stale';
        }
        await insertAll();
        return 'generation';
      }

      if (publication.epoch !== room.currentEpoch || publication.keyId !== room.currentKeyId) {
        return 'stale';
      }

      const members = new Set(await this.memberIds(tx, publication.roomId));
      const targets = publication.keys.map((key) => key.userId);
      if (new Set(targets).size !== targets.length || targets.some((userId) => !members.has(userId))) {
        return 'conflict';
      }

      const holders = await tx
        .select({ userId: roomKeys.userId })
        .from(roomKeys)
        .where(
          and(
            eq(roomKeys.roomId, publication.roomId),
            eq(roomKeys.keyId, publication.keyId),
            inArray(roomKeys.userId, [publication.senderId, ...targets]),
          ),
        );
      const holderIds = new Set(holders.map((row) => row.userId));
      if (!holderIds.has(publication.senderId) || targets.some((userId) => holderIds.has(userId))) {
        return 'conflict';
      }

      await insertAll();
      return 'share';
    });
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
