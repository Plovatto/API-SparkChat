import { and, asc, eq, gt, inArray, notExists, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../database/turso-client.js';
import { roomBans, roomKeys, roomParticipants, roomRosters, rooms, users } from '../../database/schema.js';
import type { RoomInvite } from './room.invites.js';

export interface StoredRoomKey {
  roomId: string;
  keyId: string;
  epoch: number;
  senderId: string;
  sealedKey: string;
  roster?: string;
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
  invite?: RoomInvite | undefined;
  roster?: string | undefined;
  name?: string | undefined;
}

export type RoomNameUpdateOutcome = 'updated' | 'stale' | 'notInRoster' | 'notFound';

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

export const MAX_ROSTER_BYTES_PER_RESPONSE = 256 * 1024;

export interface RosterBudgetResult {
  keys: StoredRoomKey[];
  truncated: boolean;
}

export function limitRosterBytes(keys: StoredRoomKey[], maxBytes: number = MAX_ROSTER_BYTES_PER_RESPONSE): RosterBudgetResult {
  const kept = new Set<StoredRoomKey>();
  const sent = new Set<string>();
  const replacements = new Map<StoredRoomKey, StoredRoomKey>();
  let used = 0;
  let truncated = false;
  for (const key of [...keys].sort((a, b) => b.epoch - a.epoch)) {
    if (!key.roster) {
      kept.add(key);
      continue;
    }
    const marker = `${key.roomId}
${key.roster}`;
    if (sent.has(marker)) {
      const { roster: _roster, ...withoutRoster } = key;
      replacements.set(key, withoutRoster);
      kept.add(key);
      continue;
    }
    const size = Buffer.byteLength(key.roster, 'utf8');
    if (used + size > maxBytes) {
      truncated = true;
      continue;
    }
    used += size;
    sent.add(marker);
    kept.add(key);
  }
  return {
    keys: keys.filter((key) => kept.has(key)).map((key) => replacements.get(key) ?? key),
    truncated,
  };
}

type Executor = Pick<Database, 'select' | 'update' | 'insert'>;

export function activeMemberCount(roomId: string, userIds: SQL): SQL {
  return sql`(select count(*) from ${roomParticipants} p
    where p.room_id = ${roomId} and p.user_id in ${userIds}
      and not exists (select 1 from ${roomBans} b where b.room_id = p.room_id and b.user_id = p.user_id))`;
}

export function inRosterCondition(roomId: string, userId: string, keyId: string | SQL): SQL {
  return sql`exists (select 1 from ${roomParticipants} p
    join ${roomRosters} r on r.room_id = p.room_id and r.key_id = ${keyId}
    where p.room_id = ${roomId} and p.user_id = ${userId}
      and p.joined_at is not null and p.joined_at <= r.created_at)`;
}

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
    return activeMemberCount(roomId, userIds);
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
    const { roomId, keyId, epoch, senderId, keys, invite, roster, name } = publication;
    const targetIds = sql`(${sql.join(
      keys.map((key) => sql`${key.userId}`),
      sql`, `,
    )})`;
    const inviteColumns = invite
      ? sql`, invite_token_hash = case when type = 'group' then ${invite.tokenHash} end,
          encrypted_invite = case when type = 'group' then ${invite.encryptedInvite} end,
          invite_key_id = case when type = 'group' then ${keyId} end`
      : sql``;
    const rosterColumns = roster
      ? sql`, encrypted_roster = case when type = 'group' then ${roster} end,
          roster_key_id = case when type = 'group' then ${keyId} end`
      : sql``;
    const nameColumns = name
      ? sql`, encrypted_name = case when type = 'group' then ${name} end,
          name_key_id = case when type = 'group' then ${keyId} end`
      : sql``;
    const advance = this.db.run(sql`
      update ${rooms} set current_epoch = ${epoch}, current_key_id = ${keyId}, rotation_required = null${inviteColumns}${rosterColumns}${nameColumns}
      where id = ${roomId}
        and (type <> 'group' or ${invite && roster && name ? 1 : 0} = 1)
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

    const storeRoster = this.db.run(sql`
      insert into ${roomRosters} (room_id, key_id, encrypted_roster, created_at)
      select ${roomId}, ${keyId}, ${roster ?? null}, ${new Date().toISOString()}
      where ${roster ? 1 : 0} = 1
        and exists (select 1 from ${rooms} where id = ${roomId} and type = 'group' and current_epoch = ${epoch}
          and current_key_id = ${keyId} and roster_key_id = ${keyId} and encrypted_roster = ${roster ?? null})
      on conflict do nothing
    `);

    const [advanced] = await this.db.batch([advance, insert, storeRoster]);
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

  async updateName(roomId: string, userId: string, keyId: string, encryptedName: string): Promise<RoomNameUpdateOutcome> {
    const result = await this.db.run(sql`
      update ${rooms} set encrypted_name = ${encryptedName}, name_key_id = ${keyId}
      where id = ${roomId} and type = 'group' and current_key_id = ${keyId}
        and ${this.memberCondition(roomId, sql`(${userId})`)} = 1
        and ${this.inCurrentRosterCondition(roomId, userId, keyId)}
    `);
    if (result.rowsAffected === 1) {
      return 'updated';
    }
    const [[room], memberIds] = await Promise.all([
      this.db.select({ type: rooms.type, currentKeyId: rooms.currentKeyId }).from(rooms).where(eq(rooms.id, roomId)),
      this.memberIds(this.db, roomId),
    ]);
    if (room?.type !== 'group' || !memberIds.includes(userId)) {
      return 'notFound';
    }
    return room.currentKeyId === keyId ? 'notInRoster' : 'stale';
  }

  private inCurrentRosterCondition(roomId: string, userId: string, keyId: string): SQL {
    return inRosterCondition(roomId, userId, keyId);
  }

  async findRoster(roomId: string, keyId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ encryptedRoster: roomRosters.encryptedRoster })
      .from(roomRosters)
      .where(and(eq(roomRosters.roomId, roomId), eq(roomRosters.keyId, keyId)));
    return row?.encryptedRoster ?? null;
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

  async findForParticipantInRooms(roomIds: string[], userId: string, keyIds: Record<string, string[]> = {}): Promise<StoredRoomKey[]> {
    if (roomIds.length === 0) {
      return [];
    }

    const filtered = roomIds.filter((roomId) => Object.hasOwn(keyIds, roomId));
    const unfiltered = roomIds.filter((roomId) => !Object.hasOwn(keyIds, roomId));
    const scopes: SQL[] = filtered.flatMap((roomId) => {
      const ids = keyIds[roomId] ?? [];
      return ids.length > 0 ? [and(eq(roomKeys.roomId, roomId), inArray(roomKeys.keyId, ids)) as SQL] : [];
    });
    if (unfiltered.length > 0) {
      scopes.push(inArray(roomKeys.roomId, unfiltered));
    }
    if (scopes.length === 0) {
      return [];
    }

    const rows = await this.db
      .select({
        roomId: roomKeys.roomId,
        keyId: roomKeys.keyId,
        epoch: roomKeys.epoch,
        senderId: roomKeys.senderId,
        sealedKey: roomKeys.sealedKey,
        roster: roomRosters.encryptedRoster,
      })
      .from(roomKeys)
      .innerJoin(roomParticipants, and(eq(roomParticipants.roomId, roomKeys.roomId), eq(roomParticipants.userId, roomKeys.userId)))
      .leftJoin(roomRosters, and(eq(roomRosters.roomId, roomKeys.roomId), eq(roomRosters.keyId, roomKeys.keyId)))
      .where(and(eq(roomKeys.userId, userId), or(...scopes), this.notBanned(this.db)))
      .orderBy(asc(roomKeys.epoch));

    const order = new Map(roomIds.map((roomId, index) => [roomId, index]));
    return rows
      .map(({ roster, ...key }) => (roster ? { ...key, roster } : key))
      .sort((a, b) => (order.get(a.roomId) ?? 0) - (order.get(b.roomId) ?? 0) || a.epoch - b.epoch);
  }
}
