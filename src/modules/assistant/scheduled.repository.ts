import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { scheduledMessages } from '../../database/schema.js';
import type { Database } from '../../database/turso-client.js';

export interface ScheduledRow {
  id: string;
  userId: string;
  roomId: string;
  messageId: string;
  cardId: string;
  previewSealed: string;
  payload: { content: string; type: 'text'; keyId: string };
  locale: string;
  timeZone: string;
  sendAt: number;
  status: string;
  failureReason: string | null;
  createdAt: number;
}

export class ScheduledRepository {
  constructor(private readonly db: Database) {}

  async insertIfBelow(row: ScheduledRow, limit: number): Promise<boolean> {
    const result = await this.db.run(sql`
      INSERT INTO scheduled_messages (id, user_id, room_id, message_id, card_id, preview_sealed, payload, locale, time_zone, send_at, status, failure_reason, created_at)
      SELECT ${row.id}, ${row.userId}, ${row.roomId}, ${row.messageId}, ${row.cardId}, ${row.previewSealed}, ${JSON.stringify(row.payload)},
        ${row.locale}, ${row.timeZone}, ${row.sendAt}, 'pending', NULL, ${row.createdAt}
      WHERE (SELECT COUNT(*) FROM scheduled_messages WHERE user_id = ${row.userId} AND status = 'pending') < ${limit}
    `);
    return result.rowsAffected > 0;
  }

  listPending(userId: string): Promise<ScheduledRow[]> {
    return this.db
      .select()
      .from(scheduledMessages)
      .where(and(eq(scheduledMessages.userId, userId), eq(scheduledMessages.status, 'pending')))
      .orderBy(asc(scheduledMessages.sendAt));
  }

  async find(userId: string, id: string): Promise<ScheduledRow | null> {
    const [row] = await this.db
      .select()
      .from(scheduledMessages)
      .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.userId, userId)));
    return row ?? null;
  }

  async cancel(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .update(scheduledMessages)
      .set({ status: 'cancelled' })
      .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.userId, userId), eq(scheduledMessages.status, 'pending')))
      .returning({ id: scheduledMessages.id });
    return rows.length > 0;
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(scheduledMessages).where(eq(scheduledMessages.id, id));
  }

  listDue(now: number, limit: number): Promise<ScheduledRow[]> {
    return this.db
      .select()
      .from(scheduledMessages)
      .where(and(eq(scheduledMessages.status, 'pending'), lte(scheduledMessages.sendAt, now)))
      .orderBy(asc(scheduledMessages.sendAt))
      .limit(limit);
  }

  async claim(id: string): Promise<boolean> {
    const rows = await this.db
      .update(scheduledMessages)
      .set({ status: 'sent' })
      .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.status, 'pending')))
      .returning({ id: scheduledMessages.id });
    return rows.length > 0;
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.db.update(scheduledMessages).set({ status: 'failed', failureReason: reason }).where(eq(scheduledMessages.id, id));
  }
}
