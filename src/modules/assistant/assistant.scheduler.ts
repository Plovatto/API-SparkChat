import { logger } from '../../config/logger.js';
import type { AppServer } from '../../sockets/events.js';
import type { PushService } from '../push/push.service.js';
import type { AssistantHost } from './assistant.host.js';
import { ASSISTANT_TEXTS, REMINDER_FIRED_BUTTONS } from './reminder.texts.js';
import type { FiredReminder, RemindersService } from './reminders.service.js';

export const SCHEDULER_INTERVAL_MS = 15_000;

export interface AssistantSchedulerDeps {
  io: AppServer;
  host: AssistantHost;
  reminders: RemindersService;
  push: Pick<PushService, 'reminder'>;
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
  }

  private async deliver(reminder: FiredReminder): Promise<void> {
    const { host, io, push } = this.deps;
    const text = reminder.text ?? ASSISTANT_TEXTS.firedFallback[reminder.locale];
    const roomId = await host.roomIdOf(reminder.userId);
    if (!roomId) {
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
