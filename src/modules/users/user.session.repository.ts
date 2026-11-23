import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Database } from '../../database/turso-client.js';
import { sessions } from '../../database/schema.js';
import type { SessionRecord } from './user.types.js';

function toRecord(row: typeof sessions.$inferSelect): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    authMethod: row.authMethod,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    devicePublicKey: row.devicePublicKey ?? null,
  };
}

export class UserSessionRepository {
  constructor(private readonly db: Database) {}

  async create(input: Omit<SessionRecord, 'devicePublicKey'> & { devicePublicKey?: string | null }): Promise<SessionRecord> {
    const record: SessionRecord = { ...input, devicePublicKey: input.devicePublicKey ?? null };
    await this.db.insert(sessions).values(record);
    return record;
  }

  async findByTokenForUser(userId: string, tokenHash: string): Promise<SessionRecord | null> {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.tokenHash, tokenHash)));

    return row ? toRecord(row) : null;
  }

  async findByIdForUser(userId: string, sessionId: string): Promise<SessionRecord | null> {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));

    return row ? toRecord(row) : null;
  }

  async touch(id: string): Promise<void> {
    await this.db.update(sessions).set({ lastUsedAt: new Date().toISOString() }).where(eq(sessions.id, id));
  }

  async bindDevicePublicKey(id: string, devicePublicKey: string): Promise<boolean> {
    const result = await this.db
      .update(sessions)
      .set({ devicePublicKey })
      .where(and(eq(sessions.id, id), isNull(sessions.devicePublicKey)));
    return result.rowsAffected > 0;
  }

  async listByUser(userId: string): Promise<SessionRecord[]> {
    const rows = await this.db.select().from(sessions).where(eq(sessions.userId, userId));
    return rows.map(toRecord);
  }

  async deleteAllForUser(userId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.userId, userId));
  }

  async deleteAllForUserExcept(userId: string, keepSessionId: string): Promise<void> {
    await this.db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)));
  }

  async deleteByIdForUser(userId: string, sessionId: string): Promise<void> {
    await this.db.delete(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  }
}
