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
    expect((await t.db.select().from(reminders).where(eq(reminders.id, id)))[0]).toMatchObject({ status: 'fired', lastFiredAt: T0 + 61_000 });
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

  async function lastAssistantMessageId(t: Tasks) {
    const message = (await t.messageService.getRoomMessagesPage(t.room.id, { limit: 50 })).messages.filter((item) => item.senderId === t.assistant.id).at(-1);
    return (message as NonNullable<typeof message>).id;
  }

  async function rowOf(t: Tasks, id: string) {
    return (await t.db.select().from(reminders).where(eq(reminders.id, id)))[0];
  }

  it('a failing row never drops the other claimed rows or blocks the queue', async () => {
    const t = await setupTasks();
    const bad = await t.reminders.create({ userId: t.alice.id, text: 'ruim', fireAt: T0 - 2000, timeZone: 'Not/AZone', locale: 'pt', recurrence: { freq: 'daily' }, anchor: null });
    await schedule(t, T0 - 1000);
    const open = vi.spyOn(t.host, 'open');
    open.mockRejectedValueOnce(new Error('boom'));
    const { scheduler, push } = schedulerFor(t);

    await scheduler.tick();

    expect(push.reminder).toHaveBeenCalledTimes(2);
    expect((await t.assistantTexts()).filter((text) => text?.startsWith('⏰'))).toHaveLength(2);
    expect((await rowOf(t, bad.ok ? bad.reminder.id : ''))?.status).toBe('fired');
    await scheduler.tick();
    expect(push.reminder).toHaveBeenCalledTimes(2);
  });

  it('snoozing a daily 23:30 reminder still fires it the next night at 23:30', async () => {
    const t = await setupTasks();
    const first = Date.UTC(2026, 10, 27, 2, 30);
    const id = await schedule(t, first, { freq: 'daily' }, { day: 26, hour: 23, minute: 30 });
    const { scheduler, push } = schedulerFor(t);

    t.clock.now = first;
    await scheduler.tick();
    await t.tap(await lastAssistantMessageId(t), 'snooze60');
    expect(await rowOf(t, id)).toMatchObject({ status: 'active', nextFireAt: Date.UTC(2026, 10, 28, 2, 30), snoozeAt: first + 3_600_000 });

    t.clock.now = first + 3_600_000;
    await scheduler.tick();
    expect(push.reminder).toHaveBeenCalledTimes(2);
    expect(await rowOf(t, id)).toMatchObject({ nextFireAt: Date.UTC(2026, 10, 28, 2, 30), snoozeAt: null });

    t.clock.now = Date.UTC(2026, 10, 28, 2, 30);
    await scheduler.tick();
    expect(push.reminder).toHaveBeenCalledTimes(3);
  });

  it('snoozing a weekly Monday and Tuesday reminder does not lose Tuesday', async () => {
    const t = await setupTasks();
    const monday = Date.UTC(2026, 10, 30, 12, 0);
    const id = await schedule(t, monday, { freq: 'weekly', weekdays: [1, 2] }, { day: 30, hour: 9, minute: 0 });
    const { scheduler, push } = schedulerFor(t);

    t.clock.now = monday;
    await scheduler.tick();
    await t.tap(await lastAssistantMessageId(t), 'snooze10');
    expect(await rowOf(t, id)).toMatchObject({ nextFireAt: Date.UTC(2026, 11, 1, 12, 0), snoozeAt: monday + 600_000 });

    t.clock.now = monday + 600_000;
    await scheduler.tick();
    t.clock.now = Date.UTC(2026, 11, 1, 12, 0);
    await scheduler.tick();
    expect(push.reminder).toHaveBeenCalledTimes(3);
  });

  it('done on a recurring reminder clears the snooze and keeps the series; on a one-shot it stays done and cannot be snoozed back', async () => {
    const t = await setupTasks();
    const first = Date.UTC(2026, 10, 27, 12, 0);
    const id = await schedule(t, first, { freq: 'daily' }, { day: 27, hour: 9, minute: 0 });
    const { scheduler, push } = schedulerFor(t);
    t.clock.now = first;
    await scheduler.tick();
    await t.tap(await lastAssistantMessageId(t), 'snooze10');
    const again = await t.postCard({ v: 1, kind: 'reminder-fired', reminderId: id, text: 'x', buttons: [{ choice: 'done', label: 'x' }] });
    await t.tap(again.id, 'done');
    expect((await t.assistantTexts()).at(-1)).toBe('Concluído! Te lembro de novo em sáb, 28/11 às 09:00.');
    expect(await rowOf(t, id)).toMatchObject({ status: 'active', snoozeAt: null });
    t.clock.now = first + 700_000;
    await scheduler.tick();
    expect(push.reminder).toHaveBeenCalledTimes(1);

    const oneShot = await schedule(t, t.clock.now - 1000);
    await scheduler.tick();
    const doneCard = await t.postCard({ v: 1, kind: 'reminder-fired', reminderId: oneShot, text: 'x', buttons: [{ choice: 'done', label: 'x' }] });
    await t.tap(doneCard.id, 'done');
    expect(await rowOf(t, oneShot)).toMatchObject({ status: 'done' });
    const snoozeCard = await t.postCard({ v: 1, kind: 'reminder-fired', reminderId: oneShot, text: 'x', buttons: [{ choice: 'snooze10', label: 'x' }] });
    await t.tap(snoozeCard.id, 'snooze10');
    expect((await t.assistantTexts()).at(-1)).toBe('Esse lembrete já foi concluído.');
    expect(await rowOf(t, oneShot)).toMatchObject({ status: 'done' });
  });
});
