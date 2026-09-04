import { and, eq } from 'drizzle-orm';
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
  };
}

export class UserSessionRepository {
  constructor(private readonly db: Database) {}

  async create(record: SessionRecord): Promise<SessionRecord> {
    await this.db.insert(sessions).values(record);
    return record;
  }

  async findValid(userId: string, tokenHash: string, maxAgeMs: number): Promise<SessionRecord | null> {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.tokenHash, tokenHash)));

    if (!row) {
      return null;
    }

    const record = toRecord(row);
    const age = Date.now() - new Date(record.lastUsedAt).getTime();
    return age <= maxAgeMs ? record : null;
  }

  async touch(id: string): Promise<void> {
    await this.db.update(sessions).set({ lastUsedAt: new Date().toISOString() }).where(eq(sessions.id, id));
  }

  async listByUser(userId: string): Promise<SessionRecord[]> {
    const rows = await this.db.select().from(sessions).where(eq(sessions.userId, userId));
    return rows.map(toRecord);
  }

  async deleteAllForUser(userId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.userId, userId));
  }

  async deleteByIdForUser(userId: string, sessionId: string): Promise<void> {
    await this.db.delete(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  }
}
