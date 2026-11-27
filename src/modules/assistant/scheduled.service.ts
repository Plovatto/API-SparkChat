import { randomUUID } from 'node:crypto';
import { logger } from '../../config/logger.js';
import type { Locale } from '../../lib/locale.js';
import type { AppServer } from '../../sockets/events.js';
import type { ConfirmAction, QuickReplyChoice } from './assistant.card.js';
import type { AssistantHost } from './assistant.host.js';
import { formatWhen } from './reminder.texts.js';
import type { ScheduledRepository, ScheduledRow } from './scheduled.repository.js';
import {
  SCHEDULED_DUE_BATCH,
  SCHEDULED_MAX_LEAD_MS,
  SCHEDULED_MAX_PENDING,
  SCHEDULED_SOCKET_MIN_LEAD_MS,
  SCHEDULED_STUCK_AFTER_MS,
  SCHEDULED_TEXTS,
} from './scheduled.texts.js';

export interface ScheduleCardsPort {
  openPendingConfirm(userId: string, cardId: string): Promise<{ roomId: string; action: ConfirmAction } | null>;
  claim(cardId: string, userId: string): Promise<boolean>;
  announce(io: AppServer, roomId: string, cardId: string, choice: QuickReplyChoice): void;
}

export interface ScheduledMessage {
  id: string;
  userId: string;
  roomId: string;
  messageId: string;
  payload: ScheduledRow['payload'];
  locale: Locale;
  timeZone: string;
  sendAt: number;
  text: string;
  recipient: string;
}

export interface ScheduleRequest {
  io: AppServer;
  userId: string;
  cardId: string;
  roomId: string;
  sendAt: number;
  messageId: string;
  content: string;
  keyId: string;
  locale: Locale;
}

export type ScheduleResult = { ok: true; id: string } | { ok: false; error: 'not_allowed' | 'limit' | 'unavailable' };

function toLocale(value: string): Locale {
  return value === 'en' ? 'en' : 'pt';
}

export class ScheduledMessagesService {
  constructor(
    private readonly repository: ScheduledRepository,
    private readonly host: AssistantHost,
    private readonly cards: ScheduleCardsPort,
    private readonly messageExists: (messageId: string) => Promise<boolean>,
    private readonly now: () => number = Date.now,
  ) {}

  async schedule(request: ScheduleRequest): Promise<ScheduleResult> {
    const { userId, cardId, roomId, sendAt, messageId, io } = request;
    const found = await this.cards.openPendingConfirm(userId, cardId);
    if (!found || found.action.type !== 'scheduled-message' || found.action.roomId !== roomId) {
      return { ok: false, error: 'not_allowed' };
    }
    const { action } = found;
    const current = this.now();
    if (
      sendAt < current + SCHEDULED_SOCKET_MIN_LEAD_MS ||
      sendAt > current + SCHEDULED_MAX_LEAD_MS ||
      sendAt !== action.sendAt ||
      (await this.messageExists(messageId))
    ) {
      return { ok: false, error: 'not_allowed' };
    }

    const id = randomUUID();
    const sealed = await this.host.seal(userId, 'scheduledMessage', id, JSON.stringify({ text: action.text, recipient: action.recipient }));
    if (!sealed) {
      return { ok: false, error: 'unavailable' };
    }
    const outcome = await this.repository.insertIfBelow(
      {
        id,
        userId,
        roomId,
        messageId,
        cardId,
        previewSealed: sealed,
        payload: { content: request.content, type: 'text', keyId: request.keyId },
        locale: request.locale,
        timeZone: action.timeZone,
        sendAt,
        status: 'pending',
        failureReason: null,
        claimedAt: null,
        createdAt: current,
      },
      SCHEDULED_MAX_PENDING,
    );
    if (outcome !== 'inserted') {
      return { ok: false, error: outcome === 'limit' ? 'limit' : 'not_allowed' };
    }
    if (!(await this.cards.claim(cardId, userId))) {
      await this.repository.remove(id);
      return { ok: false, error: 'not_allowed' };
    }
    this.cards.announce(io, found.roomId, cardId, 'yes');
    await this.host
      .post(io, userId, { text: SCHEDULED_TEXTS.scheduled(action.recipient, formatWhen(sendAt, action.timeZone, request.locale), request.locale), card: null })
      .catch((error: unknown) => logger.error({ err: error, userId }, 'Falha ao confirmar mensagem agendada na sala do SparkAI'));
    return { ok: true, id };
  }

  async listPending(userId: string): Promise<ScheduledMessage[]> {
    const rows = await this.repository.listPending(userId);
    const opened = await Promise.all(rows.map((row) => this.open(row)));
    return opened.filter((item): item is ScheduledMessage => item !== null);
  }

  async find(userId: string, id: string): Promise<ScheduledMessage | null> {
    const row = await this.repository.find(userId, id);
    return row?.status === 'pending' ? this.open(row) : null;
  }

  async countPending(userId: string): Promise<number> {
    return (await this.repository.listPending(userId)).length;
  }

  cancel(userId: string, id: string): Promise<boolean> {
    return this.repository.cancel(userId, id);
  }

  async claimDue(now: number, limit: number = SCHEDULED_DUE_BATCH): Promise<ScheduledMessage[]> {
    await this.recoverStuck(now, limit);
    const due = await this.repository.listDue(now, limit);
    const claimed: ScheduledMessage[] = [];
    for (const row of due) {
      try {
        if (!(await this.repository.claim(row.id, now))) {
          continue;
        }
        claimed.push((await this.open(row)) ?? this.unopened(row));
      } catch (error) {
        logger.error({ err: error, scheduledId: row.id }, 'Falha ao reivindicar mensagem agendada do SparkAI');
      }
    }
    return claimed;
  }

  markSent(id: string): Promise<boolean> {
    return this.repository.markSent(id);
  }

  private async recoverStuck(now: number, limit: number): Promise<void> {
    for (const row of await this.repository.listStuck(now - SCHEDULED_STUCK_AFTER_MS, limit)) {
      try {
        if (await this.messageExists(row.messageId)) {
          await this.repository.release(row, 'sent');
        } else {
          await this.repository.release(row, 'pending');
        }
      } catch (error) {
        logger.error({ err: error, scheduledId: row.id }, 'Falha ao recuperar mensagem agendada presa do SparkAI');
      }
    }
  }

  markFailed(id: string, reason: string): Promise<void> {
    return this.repository.markFailed(id, reason);
  }

  private async open(row: ScheduledRow): Promise<ScheduledMessage | null> {
    const plaintext = await this.host.open(row.userId, 'scheduledMessage', row.id, row.previewSealed).catch(() => null);
    if (plaintext === null) {
      return null;
    }
    try {
      const parsed = JSON.parse(plaintext) as { text?: unknown; recipient?: unknown };
      if (typeof parsed.text !== 'string' || typeof parsed.recipient !== 'string') {
        return null;
      }
      return { ...this.view(row), text: parsed.text, recipient: parsed.recipient };
    } catch {
      return null;
    }
  }

  private unopened(row: ScheduledRow): ScheduledMessage {
    return { ...this.view(row), text: '', recipient: '' };
  }

  private view(row: ScheduledRow): Omit<ScheduledMessage, 'text' | 'recipient'> {
    return {
      id: row.id,
      userId: row.userId,
      roomId: row.roomId,
      messageId: row.messageId,
      payload: row.payload,
      locale: toLocale(row.locale),
      timeZone: row.timeZone,
      sendAt: row.sendAt,
    };
  }
}
