import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
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
  snoozeAt: number | null;
  createdAt: number;
}

export interface FireUpdate {
  nextFireAt: number | null;
  firedAt: number;
  keepSchedule: boolean;
}

export class RemindersRepository {
  constructor(private readonly db: Database) {}

  async insertIfBelow(row: ReminderRow, limit: number): Promise<boolean> {
    const result = await this.db.run(sql`
      INSERT INTO reminders (id, user_id, text_sealed, next_fire_at, time_zone, locale, recurrence, anchor, status, last_fired_at, snooze_at, created_at)
      SELECT ${row.id}, ${row.userId}, ${row.textSealed}, ${row.nextFireAt}, ${row.timeZone}, ${row.locale},
        ${row.recurrence ? JSON.stringify(row.recurrence) : null}, ${row.anchor ? JSON.stringify(row.anchor) : null},
        'active', NULL, NULL, ${row.createdAt}
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
      .where(and(eq(reminders.status, 'active'), or(lte(reminders.nextFireAt, now), lte(reminders.snoozeAt, now))))
      .orderBy(asc(reminders.nextFireAt))
      .limit(limit);
  }

  async claim(row: ReminderRow, update: FireUpdate): Promise<ReminderRow | null> {
    const [claimed] = await this.db
      .update(reminders)
      .set({
        lastFiredAt: update.firedAt,
        snoozeAt: null,
        ...(update.keepSchedule ? {} : update.nextFireAt === null ? { status: 'fired' } : { nextFireAt: update.nextFireAt }),
      })
      .where(
        and(
          eq(reminders.id, row.id),
          eq(reminders.status, 'active'),
          eq(reminders.nextFireAt, row.nextFireAt),
          row.snoozeAt === null ? isNull(reminders.snoozeAt) : eq(reminders.snoozeAt, row.snoozeAt),
        ),
      )
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
      .set({ status: 'done', snoozeAt: null })
      .where(and(eq(reminders.id, id), eq(reminders.userId, userId), inArray(reminders.status, ['active', 'fired'])));
  }

  async clearSnooze(userId: string, id: string): Promise<void> {
    await this.db
      .update(reminders)
      .set({ snoozeAt: null })
      .where(and(eq(reminders.id, id), eq(reminders.userId, userId)));
  }

  async setSnooze(userId: string, id: string, at: number): Promise<boolean> {
    const rows = await this.db
      .update(reminders)
      .set({ snoozeAt: at })
      .where(and(eq(reminders.id, id), eq(reminders.userId, userId), eq(reminders.status, 'active')))
      .returning({ id: reminders.id });
    return rows.length > 0;
  }

  async reactivate(userId: string, id: string, at: number): Promise<boolean> {
    const rows = await this.db
      .update(reminders)
      .set({ status: 'active', nextFireAt: at, snoozeAt: null })
      .where(and(eq(reminders.id, id), eq(reminders.userId, userId), inArray(reminders.status, ['active', 'fired'])))
      .returning({ id: reminders.id });
    return rows.length > 0;
  }
}
