import { and, asc, eq, lte, ne, sql } from 'drizzle-orm';
import { reminders } from '../../database/schema.js';
import type { Database } from '../../database/turso-client.js';
import type { Recurrence } from './assistant.card.js';
import type { RecurrenceAnchor } from './zoned-time.js';

export interface ReminderRow {
  id: string;
  userId: string;
  textSealed: string;
  nextFireAt: number;
  timeZone: string;
  locale: string;
  recurrence: Recurrence | null;
  anchor: RecurrenceAnchor | null;
  status: string;
  lastFiredAt: number | null;
  createdAt: number;
}

export interface FireUpdate {
  nextFireAt: number | null;
  firedAt: number;
}

export class RemindersRepository {
  constructor(private readonly db: Database) {}

  async insertIfBelow(row: ReminderRow, limit: number): Promise<boolean> {
    const result = await this.db.run(sql`
      INSERT INTO reminders (id, user_id, text_sealed, next_fire_at, time_zone, locale, recurrence, anchor, status, last_fired_at, created_at)
      SELECT ${row.id}, ${row.userId}, ${row.textSealed}, ${row.nextFireAt}, ${row.timeZone}, ${row.locale},
        ${row.recurrence ? JSON.stringify(row.recurrence) : null}, ${row.anchor ? JSON.stringify(row.anchor) : null},
        'active', NULL, ${row.createdAt}
      WHERE (SELECT COUNT(*) FROM reminders WHERE user_id = ${row.userId} AND status = 'active') < ${limit}
    `);
    return result.rowsAffected > 0;
  }

  listActive(userId: string): Promise<ReminderRow[]> {
    return this.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.userId, userId), eq(reminders.status, 'active')))
      .orderBy(asc(reminders.nextFireAt));
  }

  async find(userId: string, id: string): Promise<ReminderRow | null> {
    const [row] = await this.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.id, id), eq(reminders.userId, userId)));
    return row ?? null;
  }

  listDue(now: number, limit: number): Promise<ReminderRow[]> {
    return this.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.status, 'active'), lte(reminders.nextFireAt, now)))
      .orderBy(asc(reminders.nextFireAt))
      .limit(limit);
  }

  async claim(row: ReminderRow, update: FireUpdate): Promise<ReminderRow | null> {
    const [claimed] = await this.db
      .update(reminders)
      .set({
        lastFiredAt: update.firedAt,
        ...(update.nextFireAt === null ? { status: 'done' } : { nextFireAt: update.nextFireAt }),
      })
      .where(and(eq(reminders.id, row.id), eq(reminders.status, 'active'), eq(reminders.nextFireAt, row.nextFireAt)))
      .returning();
    return claimed ?? null;
  }

  async cancel(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .update(reminders)
      .set({ status: 'cancelled' })
      .where(and(eq(reminders.id, id), eq(reminders.userId, userId), eq(reminders.status, 'active')))
      .returning({ id: reminders.id });
    return rows.length > 0;
  }

  async markDone(userId: string, id: string): Promise<void> {
    await this.db
      .update(reminders)
      .set({ status: 'done' })
      .where(and(eq(reminders.id, id), eq(reminders.userId, userId), eq(reminders.status, 'active')));
  }

  async snooze(userId: string, id: string, fireAt: number): Promise<number | null> {
    const [row] = await this.db
      .update(reminders)
      .set({
        status: 'active',
        nextFireAt: sql`CASE WHEN ${reminders.recurrence} IS NOT NULL AND ${reminders.status} = 'active' AND ${reminders.nextFireAt} < ${fireAt} THEN ${reminders.nextFireAt} ELSE ${fireAt} END`,
      })
      .where(and(eq(reminders.id, id), eq(reminders.userId, userId), ne(reminders.status, 'cancelled')))
      .returning({ nextFireAt: reminders.nextFireAt });
    return row?.nextFireAt ?? null;
  }
}
