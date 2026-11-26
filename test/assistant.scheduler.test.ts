import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { reminders } from '@/database/schema.js';
import { AssistantScheduler } from '@/modules/assistant/assistant.scheduler.js';
import { RemindersService } from '@/modules/assistant/reminders.service.js';
import { T0, TIME_ZONE, setupTasks } from './support/assistant-tasks-fixture.js';

type Tasks = Awaited<ReturnType<typeof setupTasks>>;

function schedulerFor(t: Tasks, push = { reminder: vi.fn() }) {
  const scheduler = new AssistantScheduler({ io: t.io, host: t.host, reminders: t.reminders, push }, t.now);
  return { scheduler, push };
}

async function schedule(t: Tasks, fireAt: number, recurrence: Parameters<Tasks['reminders']['create']>[0]['recurrence'] = null, anchor = null as Parameters<Tasks['reminders']['create']>[0]['anchor']) {
  const created = await t.reminders.create({ userId: t.alice.id, text: 'beber água', fireAt, timeZone: TIME_ZONE, locale: 'pt', recurrence, anchor });
  if (!created.ok) {
    throw new Error('reminder not created');
  }
  return created.reminder.id;
}

async function firedTexts(t: Tasks) {
  return (await t.assistantTexts()).filter((text) => text?.startsWith('⏰'));
}

describe('AssistantScheduler', () => {
  it('fires a due reminder once: posts the message with the card and pushes with the right data', async () => {
    const t = await setupTasks();
    const id = await schedule(t, T0 + 60_000);
    const { scheduler, push } = schedulerFor(t);

    await scheduler.tick();
    expect(await firedTexts(t)).toEqual([]);
    expect(push.reminder).not.toHaveBeenCalled();

    t.clock.now = T0 + 61_000;
    await scheduler.tick();
    await scheduler.tick();

    expect(await firedTexts(t)).toEqual(['⏰ beber água']);
    expect(push.reminder).toHaveBeenCalledTimes(1);
    expect(push.reminder).toHaveBeenCalledWith({ userId: t.alice.id, reminderId: id, text: 'beber água', roomId: t.room.id });
    const message = (await t.messageService.getRoomMessagesPage(t.room.id, { limit: 50 })).messages.filter((item) => item.senderId === t.assistant.id).at(-1);
    const card = await t.aiService['openCard'](t.room.id, message as NonNullable<typeof message>);
    expect(card).toEqual({
      v: 1,
      kind: 'reminder-fired',
      reminderId: id,
      text: 'beber água',
      buttons: [
        { choice: 'done', label: 'Concluído' },
        { choice: 'snooze10', label: 'Adiar 10 min' },
        { choice: 'snooze60', label: 'Adiar 1 h' },
      ],
    });
    expect((await t.db.select().from(reminders).where(eq(reminders.id, id)))[0]).toMatchObject({ status: 'done', lastFiredAt: T0 + 61_000 });
  });

  it('does not duplicate when two ticks run concurrently or two schedulers share the database', async () => {
    const t = await setupTasks();
    await schedule(t, T0 - 1000);
    const first = schedulerFor(t);
    const second = schedulerFor(t);
    const otherService = new RemindersService(t.remindersRepository, t.host, t.now);
    const third = new AssistantScheduler({ io: t.io, host: t.host, reminders: otherService, push: second.push }, t.now);

    await Promise.all([first.scheduler.tick(), first.scheduler.tick(), second.scheduler.tick(), third.tick()]);

    expect(await firedTexts(t)).toHaveLength(1);
    expect(first.push.reminder.mock.calls.length + second.push.reminder.mock.calls.length).toBe(1);
  });

  it('fires once after a restart when the reminder was due two hours ago', async () => {
    const t = await setupTasks();
    await schedule(t, T0 - 2 * 3_600_000);
    const { scheduler, push } = schedulerFor(t);

    await scheduler.tick();
    const { scheduler: restarted, push: restartedPush } = schedulerFor(t);
    await restarted.tick();

    expect(await firedTexts(t)).toHaveLength(1);
    expect(push.reminder).toHaveBeenCalledTimes(1);
    expect(restartedPush.reminder).not.toHaveBeenCalled();
  });

  it('reschedules a recurring reminder to the next occurrence keeping the wall time, firing once after downtime', async () => {
    const t = await setupTasks();
    const firstFire = Date.UTC(2026, 10, 20, 12, 0);
    const id = await schedule(t, firstFire, { freq: 'daily' }, { day: 20, hour: 9, minute: 0 });
    const { scheduler, push } = schedulerFor(t);

    await scheduler.tick();

    const [row] = await t.db.select().from(reminders).where(eq(reminders.id, id));
    expect(row).toMatchObject({ status: 'active', nextFireAt: Date.UTC(2026, 10, 27, 12, 0) });
    expect(push.reminder).toHaveBeenCalledTimes(1);
    expect(await firedTexts(t)).toHaveLength(1);
  });

  it('snooze after firing brings it back and fires again at the new time', async () => {
    const t = await setupTasks();
    const id = await schedule(t, T0 - 1000);
    const { scheduler, push } = schedulerFor(t);
    await scheduler.tick();

    const message = (await t.messageService.getRoomMessagesPage(t.room.id, { limit: 50 })).messages.filter((item) => item.senderId === t.assistant.id).at(-1);
    await t.tap((message as NonNullable<typeof message>).id, 'snooze10');
    expect((await t.db.select().from(reminders).where(eq(reminders.id, id)))[0]).toMatchObject({ status: 'active', nextFireAt: T0 + 600_000 });

    t.clock.now = T0 + 600_000;
    await scheduler.tick();
    expect(push.reminder).toHaveBeenCalledTimes(2);
    expect(await firedTexts(t)).toHaveLength(2);
  });

  it('start returns a stop function and ticks on the interval', async () => {
    const t = await setupTasks();
    vi.useFakeTimers();
    try {
      const { scheduler } = schedulerFor(t);
      const tick = vi.spyOn(scheduler, 'tick').mockResolvedValue();
      const stop = scheduler.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(tick).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(tick).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
