import { and, eq, notExists, sql, type SQL } from 'drizzle-orm';
import { roomBans, roomParticipants, rooms, uploads, users } from '../../database/schema.js';
import type { Database } from '../../database/turso-client.js';
import { roomAvatarOwner, userAvatarOwner } from '../../storage/upload-registry.js';
import { activeMemberCount, inRosterCondition } from '../rooms/index.js';

export type UserAvatarWrite =
  | { status: 'updated'; previousUploadKey: string | null }
  | { status: 'notFound' | 'staleVersion' | 'invalidUpload' };

export type RoomAvatarWrite =
  | { status: 'updated'; previousUploadKey: string | null }
  | { status: 'notFound' | 'stale' | 'notInRoster' | 'invalidUpload' };

export type RoomAvatarClear = { status: 'cleared'; previousUploadKey: string | null } | { status: 'notFound' | 'notInRoster' };

export type ProfileKeyWrite = { status: 'written'; envelopes: Record<string, string> } | { status: 'notFound' | 'stale' | 'notMember' };

export interface UserAvatarInput {
  userId: string;
  uploadKey: string;
  encryptedAvatar: string;
  profileKeyVersion: number;
}

export interface RoomAvatarInput {
  roomId: string;
  userId: string;
  keyId: string;
  uploadKey: string;
  encryptedAvatar: string;
}

export interface UserAvatarState {
  encryptedAvatar: string | null;
  avatarUploadKey: string | null;
  profileKeyVersion: number;
}

export class AvatarRepository {
  constructor(private readonly db: Database) {}

  async findUserAvatar(userId: string): Promise<UserAvatarState | null> {
    const [row] = await this.db
      .select({ encryptedAvatar: users.encryptedAvatar, avatarUploadKey: users.avatarUploadKey, profileKeyVersion: users.profileKeyVersion })
      .from(users)
      .where(eq(users.id, userId));
    return row ?? null;
  }

  async setUserAvatar(input: UserAvatarInput): Promise<UserAvatarWrite> {
    const { userId, uploadKey, encryptedAvatar, profileKeyVersion } = input;
    const owner = userAvatarOwner(userId);
    const previous = this.db.select({ avatarUploadKey: users.avatarUploadKey }).from(users).where(eq(users.id, userId));
    const update = this.db.run(sql`
      update ${users} set encrypted_avatar = ${encryptedAvatar}, avatar_upload_key = ${uploadKey}, profile_key_version = ${profileKeyVersion}
      where id = ${userId}
        and profile_key_version <= ${profileKeyVersion}
        and exists (select 1 from ${uploads} up
          where up.key = ${uploadKey} and up.uploader_id = ${userId} and up.message_id is null
            and (up.avatar_owner is null or (up.avatar_owner = ${owner} and up.key = ${users.avatarUploadKey})))
    `);
    const claim = this.db.run(sql`update ${uploads} set avatar_owner = ${owner} where key = ${uploadKey} and changes() = 1`);

    const [previousRows, updated] = await this.db.batch([previous, update, claim]);
    if (updated.rowsAffected === 1) {
      return { status: 'updated', previousUploadKey: previousRows[0]?.avatarUploadKey ?? null };
    }

    const current = await this.findUserAvatar(userId);
    if (!current) {
      return { status: 'notFound' };
    }
    return current.profileKeyVersion > profileKeyVersion ? { status: 'staleVersion' } : { status: 'invalidUpload' };
  }

  async clearUserAvatar(userId: string): Promise<{ previousUploadKey: string | null; profileKeyVersion: number } | null> {
    const previous = this.db.select({ avatarUploadKey: users.avatarUploadKey }).from(users).where(eq(users.id, userId));
    const clear = this.db
      .update(users)
      .set({ encryptedAvatar: null, avatarUploadKey: null })
      .where(eq(users.id, userId))
      .returning({ profileKeyVersion: users.profileKeyVersion });

    const [previousRows, cleared] = await this.db.batch([previous, clear]);
    const [row] = cleared;
    return row ? { previousUploadKey: previousRows[0]?.avatarUploadKey ?? null, profileKeyVersion: row.profileKeyVersion } : null;
  }

  async setRoomAvatar(input: RoomAvatarInput): Promise<RoomAvatarWrite> {
    const { roomId, userId, keyId, uploadKey, encryptedAvatar } = input;
    const owner = roomAvatarOwner(roomId);
    const previous = this.db.select({ avatarUploadKey: rooms.avatarUploadKey }).from(rooms).where(eq(rooms.id, roomId));
    const update = this.db.run(sql`
      update ${rooms} set encrypted_avatar = ${encryptedAvatar}, avatar_key_id = ${keyId}, avatar_upload_key = ${uploadKey}
      where id = ${roomId} and type = 'group' and current_key_id = ${keyId}
        and ${activeMemberCount(roomId, sql`(${userId})`)} = 1
        and ${inRosterCondition(roomId, userId, keyId)}
        and exists (select 1 from ${uploads} up
          where up.key = ${uploadKey} and up.message_id is null
            and ((up.avatar_owner is null and up.uploader_id = ${userId})
              or (up.avatar_owner = ${owner} and up.key = ${rooms.avatarUploadKey})))
    `);
    const claim = this.db.run(sql`update ${uploads} set avatar_owner = ${owner} where key = ${uploadKey} and changes() = 1`);

    const [previousRows, updated] = await this.db.batch([previous, update, claim]);
    if (updated.rowsAffected === 1) {
      return { status: 'updated', previousUploadKey: previousRows[0]?.avatarUploadKey ?? null };
    }

    const permission = await this.explainRoomEdit(roomId, userId, keyId);
    return permission === 'allowed' ? { status: 'invalidUpload' } : { status: permission };
  }

  async clearRoomAvatar(roomId: string, userId: string): Promise<RoomAvatarClear> {
    const previous = this.db.select({ avatarUploadKey: rooms.avatarUploadKey }).from(rooms).where(eq(rooms.id, roomId));
    const clear = this.db.run(sql`
      update ${rooms} set encrypted_avatar = null, avatar_key_id = null, avatar_upload_key = null
      where id = ${roomId} and type = 'group' and current_key_id is not null
        and ${activeMemberCount(roomId, sql`(${userId})`)} = 1
        and ${inRosterCondition(roomId, userId, sql`${rooms.currentKeyId}`)}
    `);

    const [previousRows, cleared] = await this.db.batch([previous, clear]);
    if (cleared.rowsAffected === 1) {
      return { status: 'cleared', previousUploadKey: previousRows[0]?.avatarUploadKey ?? null };
    }

    const [room] = await this.db.select({ currentKeyId: rooms.currentKeyId }).from(rooms).where(eq(rooms.id, roomId));
    const permission = await this.explainRoomEdit(roomId, userId, room?.currentKeyId ?? null);
    return { status: permission === 'notInRoster' || permission === 'stale' ? 'notInRoster' : 'notFound' };
  }

  async publishProfileKey(roomId: string, userId: string, keyId: string, envelope: string): Promise<ProfileKeyWrite> {
    const result = await this.db
      .update(roomParticipants)
      .set({ profileKeyEnvelope: envelope, profileKeyKeyId: keyId })
      .where(
        and(
          eq(roomParticipants.roomId, roomId),
          eq(roomParticipants.userId, userId),
          this.notBanned(),
          sql`exists (select 1 from ${rooms} where id = ${roomId} and current_key_id = ${keyId})`,
        ),
      );
    if (result.rowsAffected === 1) {
      return { status: 'written', envelopes: { [userId]: envelope } };
    }

    const { memberIds, currentKeyId } = await this.roomState(roomId);
    return memberIds.includes(userId) && currentKeyId !== keyId ? { status: 'stale' } : { status: 'notFound' };
  }

  async rewrapProfileKeys(roomId: string, callerId: string, keyId: string, envelopes: Record<string, string>): Promise<ProfileKeyWrite> {
    const { memberIds, currentKeyId } = await this.roomState(roomId);
    if (!memberIds.includes(callerId)) {
      return { status: 'notFound' };
    }
    if (currentKeyId !== keyId) {
      return { status: 'stale' };
    }
    const targets = Object.keys(envelopes);
    if (targets.some((id) => !memberIds.includes(id))) {
      return { status: 'notMember' };
    }
    if (targets.length === 0) {
      return { status: 'written', envelopes: {} };
    }

    const values = sql.join(
      Object.entries(envelopes).map(([id, envelope]) => sql`(${id}, ${envelope})`),
      sql`, `,
    );
    const ids = sql`(${sql.join(
      targets.map((id) => sql`${id}`),
      sql`, `,
    )})`;
    const rows = await this.db.all<{ userId: string; envelope: string }>(sql`
      update ${roomParticipants}
      set profile_key_envelope = (select v.column2 from (values ${values}) v where v.column1 = ${roomParticipants.userId}),
        profile_key_key_id = ${keyId}
      where room_id = ${roomId} and user_id in ${ids}
        and (user_id = ${callerId} or coalesce(profile_key_key_id, '') <> ${keyId})
        and not exists (select 1 from ${roomBans} b where b.room_id = ${roomParticipants.roomId} and b.user_id = ${roomParticipants.userId})
        and exists (select 1 from ${rooms} where id = ${roomId} and current_key_id = ${keyId})
        and ${activeMemberCount(roomId, sql`(${callerId})`)} = 1
      returning user_id as userId, profile_key_envelope as envelope
    `);
    return { status: 'written', envelopes: Object.fromEntries(rows.map((row) => [row.userId, row.envelope])) };
  }

  private notBanned(): SQL {
    return notExists(
      this.db
        .select({ userId: roomBans.userId })
        .from(roomBans)
        .where(and(eq(roomBans.roomId, roomParticipants.roomId), eq(roomBans.userId, roomParticipants.userId))),
    );
  }

  private async roomState(roomId: string): Promise<{ type: string | null; currentKeyId: string | null; memberIds: string[] }> {
    const [[room], members] = await Promise.all([
      this.db.select({ type: rooms.type, currentKeyId: rooms.currentKeyId }).from(rooms).where(eq(rooms.id, roomId)),
      this.db
        .select({ userId: roomParticipants.userId })
        .from(roomParticipants)
        .where(and(eq(roomParticipants.roomId, roomId), this.notBanned())),
    ]);
    return { type: room?.type ?? null, currentKeyId: room?.currentKeyId ?? null, memberIds: room ? members.map((row) => row.userId) : [] };
  }

  private async explainRoomEdit(roomId: string, userId: string, keyId: string | null): Promise<'allowed' | 'notFound' | 'stale' | 'notInRoster'> {
    const { type, currentKeyId, memberIds } = await this.roomState(roomId);
    if (type !== 'group' || !memberIds.includes(userId)) {
      return 'notFound';
    }
    if (!currentKeyId || currentKeyId !== keyId) {
      return 'stale';
    }
    const [inRoster] = await this.db.all<{ allowed: number }>(sql`select ${inRosterCondition(roomId, userId, keyId)} as allowed`);
    return inRoster?.allowed ? 'allowed' : 'notInRoster';
  }
}
