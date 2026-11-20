import { and, eq, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { roomParticipants, rooms, uploads, users } from '../database/schema.js';
import type { Database } from '../database/turso-client.js';

export interface UploadRecord {
  key: string;
  uploaderId: string;
  size: number;
  createdAt: string;
  messageId: string | null;
  expiresAt: string | null;
  avatarOwner: string | null;
}

export interface RegisterUploadOptions {
  expiresAt?: string | null;
}

export interface ReserveUploadOptions extends RegisterUploadOptions {
  permanentLimitBytes?: number;
  expiringLimitBytes?: number;
}

export type AvatarOwner = `user:${string}` | `room:${string}`;

export function userAvatarOwner(userId: string): AvatarOwner {
  return `user:${userId}`;
}

export function roomAvatarOwner(roomId: string): AvatarOwner {
  return `room:${roomId}`;
}

function avatarUnreferenced(): SQL {
  return sql`not exists (select 1 from ${users} u
      where substr(${uploads.avatarOwner}, 1, 5) = 'user:' and u.id = substr(${uploads.avatarOwner}, 6) and u.avatar_upload_key = ${uploads.key})
    and not exists (select 1 from ${rooms} r
      where substr(${uploads.avatarOwner}, 1, 5) = 'room:' and r.id = substr(${uploads.avatarOwner}, 6) and r.avatar_upload_key = ${uploads.key}
        and exists (select 1 from ${roomParticipants} p where p.room_id = r.id))`;
}

export class UploadRegistry {
  constructor(private readonly db: Database) {}

  async register(key: string, uploaderId: string, size: number, options: RegisterUploadOptions = {}): Promise<void> {
    await this.db.insert(uploads).values({
      key,
      uploaderId,
      size,
      createdAt: new Date().toISOString(),
      messageId: null,
      expiresAt: options.expiresAt ?? null,
      avatarOwner: null,
    });
  }

  async reserve(key: string, uploaderId: string, size: number, options: ReserveUploadOptions = {}): Promise<boolean> {
    const conditions: SQL[] = [];
    if (options.permanentLimitBytes !== undefined) {
      conditions.push(
        sql`(select coalesce(sum(size), 0) from ${uploads} where uploader_id = ${uploaderId} and expires_at is null) + ${size} <= ${options.permanentLimitBytes}`,
      );
    }
    if (options.expiringLimitBytes !== undefined) {
      conditions.push(
        sql`(select coalesce(sum(size), 0) from ${uploads} where uploader_id = ${uploaderId} and expires_at is not null) + ${size} <= ${options.expiringLimitBytes}`,
      );
    }
    const guard = conditions.length > 0 ? sql`where ${sql.join(conditions, sql` and `)}` : sql``;
    const result = await this.db.run(sql`
      insert into uploads (key, uploader_id, size, created_at, message_id, expires_at, avatar_owner)
      select ${key}, ${uploaderId}, ${size}, ${new Date().toISOString()}, null, ${options.expiresAt ?? null}, null
      ${guard}
    `);
    return result.rowsAffected > 0;
  }

  async find(key: string): Promise<UploadRecord | null> {
    const [row] = await this.db.select().from(uploads).where(eq(uploads.key, key));
    return row ?? null;
  }

  findByMessage(messageId: string): Promise<UploadRecord[]> {
    return this.db.select().from(uploads).where(eq(uploads.messageId, messageId));
  }

  async totalBytesFor(uploaderId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`coalesce(sum(${uploads.size}), 0)` })
      .from(uploads)
      .where(and(eq(uploads.uploaderId, uploaderId), isNull(uploads.expiresAt)));
    return Number(row?.total ?? 0);
  }

  async expiringBytesFor(uploaderId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`coalesce(sum(${uploads.size}), 0)` })
      .from(uploads)
      .where(and(eq(uploads.uploaderId, uploaderId), isNotNull(uploads.expiresAt)));
    return Number(row?.total ?? 0);
  }

  async claim(keys: string[], uploaderId: string, messageId: string): Promise<boolean> {
    if (keys.length === 0) {
      return true;
    }

    const claimed = await this.db
      .update(uploads)
      .set({ messageId })
      .where(and(inArray(uploads.key, keys), eq(uploads.uploaderId, uploaderId), isNull(uploads.messageId), isNull(uploads.avatarOwner)))
      .returning({ key: uploads.key });

    if (claimed.length === new Set(keys).size) {
      return true;
    }

    await this.release(messageId);
    return false;
  }

  async release(messageId: string): Promise<void> {
    await this.db.update(uploads).set({ messageId: null }).where(eq(uploads.messageId, messageId));
  }

  async remove(key: string): Promise<boolean> {
    const removed = await this.db.delete(uploads).where(eq(uploads.key, key)).returning({ key: uploads.key });
    return removed.length > 0;
  }

  async removeIfUnattached(key: string): Promise<boolean> {
    const removed = await this.db
      .delete(uploads)
      .where(and(eq(uploads.key, key), isNull(uploads.messageId), isNull(uploads.avatarOwner)))
      .returning({ key: uploads.key });
    return removed.length > 0;
  }

  async removeUnreferencedAvatar(key: string): Promise<number | null> {
    const [removed] = await this.db
      .delete(uploads)
      .where(and(eq(uploads.key, key), isNotNull(uploads.avatarOwner), avatarUnreferenced()))
      .returning({ size: uploads.size });
    return removed ? removed.size : null;
  }

  findUnreferencedAvatars(limit: number): Promise<UploadRecord[]> {
    return this.db
      .select()
      .from(uploads)
      .where(and(isNotNull(uploads.avatarOwner), avatarUnreferenced()))
      .limit(limit);
  }

  findUnattachedBefore(cutoff: string, limit: number): Promise<UploadRecord[]> {
    return this.db
      .select()
      .from(uploads)
      .where(and(isNull(uploads.messageId), isNull(uploads.avatarOwner), lt(uploads.createdAt, cutoff)))
      .limit(limit);
  }

  findExpiredBefore(cutoff: string, limit: number): Promise<UploadRecord[]> {
    return this.db
      .select()
      .from(uploads)
      .where(and(isNotNull(uploads.expiresAt), isNull(uploads.avatarOwner), lt(uploads.expiresAt, cutoff)))
      .limit(limit);
  }

  async removeIfExpired(key: string, cutoff: string): Promise<boolean> {
    const removed = await this.db
      .delete(uploads)
      .where(and(eq(uploads.key, key), isNotNull(uploads.expiresAt), isNull(uploads.avatarOwner), lt(uploads.expiresAt, cutoff)))
      .returning({ key: uploads.key });
    return removed.length > 0;
  }
}
