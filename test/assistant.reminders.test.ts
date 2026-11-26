import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { reminders } from '@/database/schema.js';
import { REMINDERS_MAX_ACTIVE } from '@/modules/assistant/reminders.service.js';
import { T0, TIME_ZONE, setupTasks } from './support/assistant-tasks-fixture.js';

const TOMORROW_9H = Date.UTC(2026, 10, 27, 12, 0);

async function rows(t: Awaited<ReturnType<typeof setupTasks>>) {
  return t.db.select().from(reminders).where(eq(reminders.userId, t.alice.id));
}

describe('reminder tools', () => {
  it('create_reminder without a time asks for it instead of inventing one', async () => {
    const t = await setupTasks();
    const result = await t.toolbox.run('create_reminder', { text: 'beber água' }, t.toolContext());
    expect(result.response).toEqual({ error: 'need_time' });
    expect(result.card).toBeUndefined();
    expect(await rows(t)).toHaveLength(0);
  });

  it('create_reminder with a time returns a confirm card and a summary in words, without saving yet', async () => {
    const t = await setupTasks();
    const result = await t.toolbox.run('create_reminder', { text: 'beber água', whenLocal: '2026-11-27T09:00' }, t.toolContext());
    expect(result.response).toMatchObject({ awaitingConfirmation: true, summary: "Lembrar 'beber água' em sex, 27/11 às 09:00?" });
    expect(result.card).toEqual({
      v: 1,
      kind: 'confirm',
      action: { type: 'reminder', text: 'beber água', fireAtLocal: '2026-11-27T09:00', timeZone: TIME_ZONE, recurrence: null },
      buttons: [
        { choice: 'yes', label: 'Sim' },
        { choice: 'no', label: 'Não' },
      ],
    });
    expect(await rows(t)).toHaveLength(0);

    const english = await t.toolbox.run('create_reminder', { text: 'drink water', whenLocal: '2026-11-27T09:00' }, t.toolContext('en'));
    expect(english.response).toMatchObject({ summary: "Remind you 'drink water' on Fri, 11/27 at 9:00 AM?" });
    expect(english.card).toMatchObject({ buttons: [{ label: 'Yes' }, { label: 'No' }] });
  });

  it('rejects invalid, too soon and too far times', async () => {
    const t = await setupTasks();
    const run = (whenLocal: string) => t.toolbox.run('create_reminder', { text: 'x', whenLocal }, t.toolContext());
    expect((await run('amanhã')).response).toEqual({ error: 'invalid_time' });
    expect((await run('2026-11-26T09:00')).response).toEqual({ error: 'too_soon' });
    expect((await run('2028-01-01T09:00')).response).toEqual({ error: 'too_far' });
  });

  it('yes creates an active reminder with the right UTC time and sealed text; no creates nothing', async () => {
    const t = await setupTasks();
    const result = await t.toolbox.run('create_reminder', { text: 'beber água', whenLocal: '2026-11-27T09:00' }, t.toolContext());
    const declined = await t.postCard(result.card as never);
    await t.tap(declined.id, 'no');
    expect((await t.assistantTexts()).at(-1)).toBe('Ok, não vou lembrar.');
    expect(await rows(t)).toHaveLength(0);

    const accepted = await t.postCard(result.card as never);
    await t.tap(accepted.id, 'yes');
    await t.tap(accepted.id, 'yes');
    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ status: 'active', nextFireAt: TOMORROW_9H, timeZone: TIME_ZONE, recurrence: null });
    expect(stored[0]?.textSealed.startsWith('e2e:v2:')).toBe(true);
    expect(stored[0]?.textSealed).not.toContain('água');
    expect((await t.assistantTexts()).at(-1)).toBe('Combinado! Te lembro em sex, 27/11 às 09:00.');
  });

  it('yes after the time has passed does not create the reminder', async () => {
    const t = await setupTasks();
    const result = await t.toolbox.run('create_reminder', { text: 'x', whenLocal: '2026-11-27T09:00' }, t.toolContext());
    const card = await t.postCard(result.card as never);
    t.clock.now = TOMORROW_9H + 1000;
    await t.tap(card.id, 'yes');
    expect(await rows(t)).toHaveLength(0);
    expect((await t.assistantTexts()).at(-1)).toContain('já passou');
  });

  it('stores the recurrence and the original anchor', async () => {
    const t = await setupTasks();
    const recurrence = { freq: 'monthly', interval: 1 };
    const result = await t.toolbox.run('create_reminder', { text: 'aluguel', whenLocal: '2026-12-31T08:30', recurrence }, t.toolContext());
    const card = await t.postCard(result.card as never);
    await t.tap(card.id, 'yes');
    expect((await rows(t))[0]).toMatchObject({ recurrence, anchor: { day: 31, hour: 8, minute: 30 } });
  });

  it('refuses the 51st active reminder', async () => {
    const t = await setupTasks();
    const input = { userId: t.alice.id, text: 'x', fireAt: TOMORROW_9H, timeZone: TIME_ZONE, locale: 'pt' as const, recurrence: null, anchor: null };
    for (let index = 0; index < REMINDERS_MAX_ACTIVE; index += 1) {
      expect((await t.reminders.create(input)).ok).toBe(true);
    }
    expect(await t.reminders.create(input)).toEqual({ ok: false, error: 'limit' });
  });

  it('list_reminders and cancel_reminder work through the confirm flow', async () => {
    const t = await setupTasks();
    const created = await t.reminders.create({ userId: t.alice.id, text: 'ligar', fireAt: TOMORROW_9H, timeZone: TIME_ZONE, locale: 'pt', recurrence: null, anchor: null });
    const id = created.ok ? created.reminder.id : '';

    const listed = await t.toolbox.run('list_reminders', {}, t.toolContext());
    expect(listed.card).toEqual({ v: 1, kind: 'list', title: 'Seus lembretes', items: [{ id, text: 'ligar', detail: 'sex, 27/11 às 09:00' }] });

    const asked = await t.toolbox.run('cancel_reminder', { reminderId: id }, t.toolContext());
    expect(asked.card).toMatchObject({ kind: 'confirm', action: { type: 'cancel-reminder', reminderId: id, preview: 'ligar' } });
    const card = await t.postCard(asked.card as never);
    await t.tap(card.id, 'yes');
    expect((await rows(t))[0]?.status).toBe('cancelled');
    expect((await t.toolbox.run('cancel_reminder', { reminderId: id }, t.toolContext())).response).toEqual({ error: 'not_found' });
  });

  it('refuses over-long reminder text counted in characters and snaps weekly reminders to the first matching weekday', async () => {
    const t = await setupTasks();
    const long = await t.toolbox.run('create_reminder', { text: 'x'.repeat(501), whenLocal: '2026-11-27T09:00' }, t.toolContext());
    expect(long.response).toEqual({ error: 'too_long' });
    const emojis = await t.toolbox.run('create_reminder', { text: '😀'.repeat(500), whenLocal: '2026-11-27T09:00' }, t.toolContext());
    expect(emojis.response).toMatchObject({ awaitingConfirmation: true });
    expect((await t.notes.add(t.alice.id, '😀'.repeat(1000))).ok).toBe(true);

    const weekly = await t.toolbox.run('create_reminder', { text: 'aula', whenLocal: '2026-11-26T09:00', recurrence: { freq: 'weekly', weekdays: [1] } }, t.toolContext());
    expect(weekly.card).toMatchObject({ action: { fireAtLocal: '2026-11-30T09:00', recurrence: { freq: 'weekly', weekdays: [1] } } });
    expect(String(weekly.response.summary)).toContain('seg, 30/11 às 09:00');
  });

  it('cancelling another user reminder has no effect', async () => {
    const t = await setupTasks();
    const created = await t.reminders.create({ userId: t.alice.id, text: 'ligar', fireAt: TOMORROW_9H, timeZone: TIME_ZONE, locale: 'pt', recurrence: null, anchor: null });
    const id = created.ok ? created.reminder.id : '';
    expect(await t.reminders.cancel('outra-pessoa', id)).toBe(false);
    expect((await rows(t))[0]?.status).toBe('active');
  });

  it('snooze10 and snooze60 move the reminder and done completes it', async () => {
    const t = await setupTasks();
    const created = await t.reminders.create({ userId: t.alice.id, text: 'ligar', fireAt: T0 - 1000, timeZone: TIME_ZONE, locale: 'pt', recurrence: null, anchor: null });
    const id = created.ok ? created.reminder.id : '';
    const card = {
      v: 1 as const,
      kind: 'reminder-fired' as const,
      reminderId: id,
      text: 'ligar',
      buttons: [
        { choice: 'snooze10' as const, label: 'x' },
        { choice: 'snooze60' as const, label: 'x' },
        { choice: 'done' as const, label: 'x' },
      ],
    };

    const first = await t.postCard(card);
    await t.tap(first.id, 'snooze10');
    expect((await rows(t))[0]).toMatchObject({ status: 'active', nextFireAt: T0 + 10 * 60_000 });
    expect((await t.assistantTexts()).at(-1)).toBe('Adiado! Te lembro de novo em qui, 26/11 às 09:10.');

    const second = await t.postCard(card);
    await t.tap(second.id, 'snooze60');
    expect((await rows(t))[0]?.nextFireAt).toBe(T0 + 60 * 60_000);

    const third = await t.postCard(card);
    await t.tap(third.id, 'done');
    expect((await rows(t))[0]?.status).toBe('done');
    expect((await t.assistantTexts()).at(-1)).toBe('Concluído! ✅');
  });
});
