import { randomUUID } from 'node:crypto';
import { logger } from '../../config/logger.js';
import type { Locale } from '../../lib/locale.js';
import type { Recurrence } from './assistant.card.js';
import type { AssistantHost } from './assistant.host.js';
import type { ReminderRow, RemindersRepository } from './reminders.repository.js';
import { nextOccurrence, type RecurrenceAnchor } from './zoned-time.js';

export const REMINDER_TEXT_MAX_LENGTH = 500;
export const REMINDERS_MAX_ACTIVE = 50;
export const REMINDER_MIN_LEAD_MS = 60_000;
export const REMINDER_MAX_LEAD_MS = 366 * 86_400_000;
export const REMINDER_DUE_BATCH = 50;
const MAX_CATCH_UP_STEPS = 2000;

export interface Reminder {
  id: string;
  userId: string;
  text: string;
  nextFireAt: number;
  timeZone: string;
  locale: Locale;
  recurrence: Recurrence | null;
  status: string;
}

export interface FiredReminder extends Omit<Reminder, 'text'> {
  text: string | null;
}

export interface NewReminder {
  userId: string;
  text: string;
  fireAt: number;
  timeZone: string;
  locale: Locale;
  recurrence: Recurrence | null;
  anchor: RecurrenceAnchor | null;
}

export type CompleteResult = { kind: 'missing' } | { kind: 'done' } | { kind: 'recurring'; next: number };

export type SnoozeResult = { kind: 'missing' } | { kind: 'done' } | { kind: 'ok'; at: number };

export type CreateReminderResult = { ok: true; reminder: Reminder } | { ok: false; error: 'empty' | 'too_long' | 'limit' | 'unavailable' };

function toLocale(value: string): Locale {
  return value === 'en' ? 'en' : 'pt';
}

function view(row: ReminderRow, text: string): Reminder {
  return {
    id: row.id,
    userId: row.userId,
    text,
    nextFireAt: row.nextFireAt,
    timeZone: row.timeZone,
    locale: toLocale(row.locale),
    recurrence: row.recurrence,
    status: row.status,
  };
}

export class RemindersService {
  constructor(
    private readonly repository: RemindersRepository,
    private readonly host: AssistantHost,
    private readonly now: () => number = Date.now,
  ) {}

  async create(input: NewReminder): Promise<CreateReminderResult> {
    const text = input.text.trim();
    if (text.length === 0) {
      return { ok: false, error: 'empty' };
    }
    if (Array.from(text).length > REMINDER_TEXT_MAX_LENGTH) {
      return { ok: false, error: 'too_long' };
    }
    const id = randomUUID();
    const sealed = await this.host.seal(input.userId, 'reminder', id, text);
    if (!sealed) {
      return { ok: false, error: 'unavailable' };
    }
    const row: ReminderRow = {
      id,
      userId: input.userId,
      textSealed: sealed,
      nextFireAt: input.fireAt,
      timeZone: input.timeZone,
      locale: input.locale,
      recurrence: input.recurrence,
      anchor: input.anchor,
      status: 'active',
      lastFiredAt: null,
      snoozeAt: null,
      createdAt: this.now(),
    };
    if (!(await this.repository.insertIfBelow(row, REMINDERS_MAX_ACTIVE))) {
      return { ok: false, error: 'limit' };
    }
    return { ok: true, reminder: view(row, text) };
  }

  async listActive(userId: string): Promise<Reminder[]> {
    const rows = await this.repository.listActive(userId);
    const opened = await Promise.all(
      rows.map(async (row) => {
        const text = await this.host.open(userId, 'reminder', row.id, row.textSealed);
        return text === null ? null : view(row, text);
      }),
    );
    return opened.filter((reminder): reminder is Reminder => reminder !== null);
  }

  async find(userId: string, id: string): Promise<Reminder | null> {
    const row = await this.repository.find(userId, id);
    if (!row) {
      return null;
    }
    const text = await this.host.open(userId, 'reminder', row.id, row.textSealed);
    return text === null ? null : view(row, text);
  }

  cancel(userId: string, id: string): Promise<boolean> {
    return this.repository.cancel(userId, id);
  }

  async complete(userId: string, id: string): Promise<CompleteResult> {
    const row = await this.repository.find(userId, id);
    if (!row || row.status === 'cancelled') {
      return { kind: 'missing' };
    }
    if (row.recurrence) {
      await this.repository.clearSnooze(userId, id);
      return { kind: 'recurring', next: row.nextFireAt };
    }
    await this.repository.markDone(userId, id);
    return { kind: 'done' };
  }

  async snooze(userId: string, id: string, minutes: number): Promise<SnoozeResult> {
    const row = await this.repository.find(userId, id);
    if (!row || row.status === 'cancelled') {
      return { kind: 'missing' };
    }
    if (row.status === 'done') {
      return { kind: 'done' };
    }
    const at = this.now() + minutes * 60_000;
    const changed = row.recurrence ? await this.repository.setSnooze(userId, id, at) : await this.repository.reactivate(userId, id, at);
    return changed ? { kind: 'ok', at } : { kind: 'missing' };
  }

  async claimDue(now: number, limit: number = REMINDER_DUE_BATCH): Promise<FiredReminder[]> {
    const due = await this.repository.listDue(now, limit);
    const fired: FiredReminder[] = [];
    for (const row of due) {
      try {
        const keepSchedule = row.snoozeAt !== null && row.snoozeAt <= now && row.nextFireAt > now;
        const claimed = await this.repository.claim(row, { nextFireAt: keepSchedule ? row.nextFireAt : this.following(row, now), firedAt: now, keepSchedule });
        if (!claimed) {
          continue;
        }
        const text = await this.host.open(row.userId, 'reminder', row.id, row.textSealed).catch(() => null);
        fired.push({ ...view(row, ''), text });
      } catch (error) {
        logger.error({ err: error, reminderId: row.id }, 'Falha ao reivindicar lembrete do SparkAI');
      }
    }
    return fired;
  }

  private following(row: ReminderRow, now: number): number | null {
    if (!row.recurrence) {
      return null;
    }
    try {
      let next = row.nextFireAt;
      for (let step = 0; step < MAX_CATCH_UP_STEPS && next <= now; step += 1) {
        next = nextOccurrence(next, row.recurrence, row.timeZone, row.anchor ?? undefined);
      }
      return next > now ? next : null;
    } catch (error) {
      logger.error({ err: error, reminderId: row.id }, 'Não foi possível calcular a próxima ocorrência do lembrete');
      return null;
    }
  }
}
