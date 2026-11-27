import { logger } from '../../config/logger.js';
import type { AppServer } from '../../sockets/events.js';
import type { PushService } from '../push/push.service.js';
import type { AssistantHost } from './assistant.host.js';
import type { ScheduledDelivery } from './scheduled.delivery.js';
import type { ScheduledMessage, ScheduledMessagesService } from './scheduled.service.js';
import { SCHEDULED_FAILED_BUTTONS, SCHEDULED_TEXTS } from './scheduled.texts.js';
import { ASSISTANT_TEXTS, REMINDER_FIRED_BUTTONS } from './reminder.texts.js';
import type { FiredReminder, RemindersService } from './reminders.service.js';

export const SCHEDULER_INTERVAL_MS = 15_000;

export interface AssistantSchedulerDeps {
  io: AppServer;
  host: AssistantHost;
  reminders: RemindersService;
  push: Pick<PushService, 'reminder'>;
  scheduled?: Pick<ScheduledMessagesService, 'claimDue' | 'markFailed' | 'markSent'>;
  delivery?: Pick<ScheduledDelivery, 'send'>;
  statuses?: { expireStatuses(now: number): Promise<string[]>; broadcastProfile(io: AppServer, userId: string): Promise<void> };
}

export class AssistantScheduler {
  private running: Promise<void> | null = null;

  constructor(
    private readonly deps: AssistantSchedulerDeps,
    private readonly now: () => number = Date.now,
    private readonly intervalMs: number = SCHEDULER_INTERVAL_MS,
  ) {}

  start(): () => void {
    const timer = setInterval(() => {
      this.tick().catch((error: unknown) => logger.error({ err: error }, 'Falha no agendador do SparkAI'));
    }, this.intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  tick(): Promise<void> {
    if (!this.running) {
      this.running = this.runOnce().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runOnce(): Promise<void> {
    const fired = await this.deps.reminders.claimDue(this.now());
    for (const reminder of fired) {
      await this.deliver(reminder).catch((error: unknown) => logger.error({ err: error, reminderId: reminder.id }, 'Falha ao entregar lembrete do SparkAI'));
    }
    await this.sendScheduled().catch((error: unknown) => logger.error({ err: error }, 'Falha ao enviar mensagens agendadas do SparkAI'));
    await this.expireStatuses().catch((error: unknown) => logger.error({ err: error }, 'Falha ao expirar status do SparkAI'));
  }

  private async sendScheduled(): Promise<void> {
    const { scheduled, delivery, io } = this.deps;
    if (!scheduled || !delivery) {
      return;
    }
    for (const item of await scheduled.claimDue(this.now())) {
      try {
        const outcome = await delivery.send(io, item);
        if (outcome.kind === 'failed') {
          await this.failScheduled(item, outcome.reason);
        } else {
          await scheduled.markSent(item.id);
        }
      } catch (error) {
        logger.error({ err: error, scheduledId: item.id }, 'Falha ao enviar mensagem agendada do SparkAI');
        await this.failScheduled(item, 'error').catch((failure: unknown) => logger.error({ err: failure, scheduledId: item.id }, 'Falha ao registrar mensagem agendada com erro'));
      }
    }
  }

  private async failScheduled(item: ScheduledMessage, reason: string): Promise<void> {
    const { scheduled, host, io } = this.deps;
    await scheduled?.markFailed(item.id, reason);
    if (item.text === '') {
      await host.post(io, item.userId, { text: SCHEDULED_TEXTS.failedUnknown[item.locale], card: null });
      return;
    }
    await host.post(io, item.userId, {
      text: SCHEDULED_TEXTS.failed(item.recipient, item.locale),
      card: { v: 1, kind: 'scheduled-failed', roomId: item.roomId, text: item.text, buttons: SCHEDULED_FAILED_BUTTONS[item.locale] },
    });
  }

  private async expireStatuses(): Promise<void> {
    const { statuses } = this.deps;
    if (!statuses) {
      return;
    }
    for (const userId of await statuses.expireStatuses(this.now())) {
      await statuses.broadcastProfile(this.deps.io, userId).catch((error: unknown) => logger.error({ err: error, userId }, 'Falha ao transmitir status restaurado'));
    }
  }

  private async deliver(reminder: FiredReminder): Promise<void> {
    const { host, io, push } = this.deps;
    const text = reminder.text ?? ASSISTANT_TEXTS.firedFallback[reminder.locale];
    const roomId = await host.roomIdOf(reminder.userId);
    if (!roomId) {
      logger.warn({ reminderId: reminder.id }, 'Lembrete vencido sem sala do SparkAI para entregar');
      return;
    }
    try {
      await host.post(io, reminder.userId, {
        text: ASSISTANT_TEXTS.fired(text),
        card: { v: 1, kind: 'reminder-fired', reminderId: reminder.id, text, buttons: REMINDER_FIRED_BUTTONS[reminder.locale] },
      });
    } catch (error) {
      logger.error({ err: error, reminderId: reminder.id }, 'Falha ao postar lembrete na sala do SparkAI');
    }
    push.reminder({ userId: reminder.userId, reminderId: reminder.id, text, roomId });
  }
}
