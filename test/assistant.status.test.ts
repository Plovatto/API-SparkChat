import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { users } from '@/database/schema.js';
import { AssistantScheduler } from '@/modules/assistant/assistant.scheduler.js';
import { setupTasks } from './support/assistant-tasks-fixture.js';

type Tasks = Awaited<ReturnType<typeof setupTasks>>;

const TODAY_15H = '2026-11-26T15:00';
const TODAY_15H_UTC = Date.UTC(2026, 10, 26, 18, 0);

async function row(t: Tasks) {
  return (await t.db.select().from(users).where(eq(users.id, t.alice.id)))[0];
}

async function applyStatus(t: Tasks, text: string, untilLocal: string) {
  const result = await t.toolbox.run('set_status', { text, untilLocal }, t.toolContext());
  const card = await t.postCard(result.card as never);
  await t.tap(card.id, 'yes');
  return result;
}

function scheduler(t: Tasks) {
  return new AssistantScheduler({ io: t.io, host: t.host, reminders: t.reminders, push: { reminder: vi.fn() }, statuses: t.statuses }, t.now);
}

function profileEvents(t: Tasks) {
  return t.emitted.filter((item) => item.event === 'user:profile-updated');
}

describe('set_status', () => {
  it('rejects text of 31 characters and empty text as invalid_args', async () => {
    const t = await setupTasks();
    expect((await t.toolbox.run('set_status', { text: 'x'.repeat(31), untilLocal: TODAY_15H }, t.toolContext())).response).toEqual({ error: 'invalid_args' });
    expect((await t.toolbox.run('set_status', { text: '  ', untilLocal: TODAY_15H }, t.toolContext())).response).toEqual({ error: 'invalid_args' });
    expect((await t.toolbox.run('set_status', { text: 'x'.repeat(30), untilLocal: TODAY_15H }, t.toolContext())).response).toMatchObject({ awaitingConfirmation: true });
  });

  it('asks for the end time and rejects invalid, past and beyond 7 days', async () => {
    const t = await setupTasks();
    const run = (untilLocal?: string) => t.toolbox.run('set_status', { text: 'Em reunião', ...(untilLocal ? { untilLocal } : {}) }, t.toolContext());
    expect((await run()).response).toEqual({ error: 'need_time' });
    expect((await run('hoje')).response).toEqual({ error: 'invalid_time' });
    expect((await run('2026-11-26T08:00')).response).toEqual({ error: 'too_soon' });
    expect((await run('2026-12-04T09:00')).response).toEqual({ error: 'too_far' });
    expect((await run('2026-12-03T09:00')).response).toMatchObject({ awaitingConfirmation: true });
  });

  it('returns a confirm card with a summary and changes nothing yet', async () => {
    const t = await setupTasks();
    const result = await t.toolbox.run('set_status', { text: 'Em reunião', untilLocal: TODAY_15H }, t.toolContext());
    expect(result.response).toMatchObject({ summary: "Colocar seu status como 'Em reunião' até 15:00?" });
    expect(result.card).toMatchObject({ kind: 'confirm', action: { type: 'status', text: 'Em reunião', untilLocal: TODAY_15H, timeZone: 'America/Sao_Paulo' } });
    expect((await row(t))?.statusText).toBeNull();
  });

  it('yes applies the status, emits user:profile-updated and answers in the person language', async () => {
    const t = await setupTasks();
    await applyStatus(t, 'Em reunião', TODAY_15H);
    expect(await row(t)).toMatchObject({ statusText: 'Em reunião', statusTextExpiresAt: TODAY_15H_UTC, statusTextPrevious: null });
    expect(profileEvents(t).at(-1)?.payload).toMatchObject({ userId: t.alice.id, statusText: 'Em reunião' });
    expect((await t.assistantTexts()).at(-1)).toBe("Prontinho! Seu status agora é 'Em reunião' até 15:00.");
  });

  it('no leaves the status as it was', async () => {
    const t = await setupTasks();
    const result = await t.toolbox.run('set_status', { text: 'Em reunião', untilLocal: TODAY_15H }, t.toolContext());
    const card = await t.postCard(result.card as never);
    await t.tap(card.id, 'no');
    expect((await t.assistantTexts()).at(-1)).toBe('Ok, deixei seu status como estava.');
    expect((await row(t))?.statusText).toBeNull();
  });

  it('yes after the time has passed does not apply', async () => {
    const t = await setupTasks();
    const result = await t.toolbox.run('set_status', { text: 'Em reunião', untilLocal: TODAY_15H }, t.toolContext());
    const card = await t.postCard(result.card as never);
    t.clock.now = TODAY_15H_UTC + 1000;
    await t.tap(card.id, 'yes');
    expect((await row(t))?.statusText).toBeNull();
    expect((await t.assistantTexts()).at(-1)).toContain('já passou');
  });
});

describe('status expiry', () => {
  it('tick after the deadline restores the previous status and broadcasts', async () => {
    const t = await setupTasks();
    await t.userService.updateStatusText(t.alice.id, 'no trampo');
    await applyStatus(t, 'Em reunião', TODAY_15H);
    t.emitted.length = 0;

    await scheduler(t).tick();
    expect((await row(t))?.statusText).toBe('Em reunião');
    expect(profileEvents(t)).toHaveLength(0);

    t.clock.now = TODAY_15H_UTC + 1000;
    await scheduler(t).tick();
    expect(await row(t)).toMatchObject({ statusText: 'no trampo', statusTextExpiresAt: null, statusTextPrevious: null });
    expect(profileEvents(t).at(-1)?.payload).toMatchObject({ userId: t.alice.id, statusText: 'no trampo' });

    t.emitted.length = 0;
    await scheduler(t).tick();
    expect(profileEvents(t)).toHaveLength(0);
  });

  it('restores to empty when there was no previous status', async () => {
    const t = await setupTasks();
    await applyStatus(t, 'Em reunião', TODAY_15H);
    t.clock.now = TODAY_15H_UTC + 1000;
    await scheduler(t).tick();
    expect((await row(t))?.statusText).toBeNull();
  });

  it('a manual change cancels the deadline', async () => {
    const t = await setupTasks();
    await t.userService.updateStatusText(t.alice.id, 'no trampo');
    await applyStatus(t, 'Em reunião', TODAY_15H);
    await t.userService.updateStatusText(t.alice.id, 'livre');
    expect(await row(t)).toMatchObject({ statusText: 'livre', statusTextExpiresAt: null, statusTextPrevious: null });

    t.clock.now = TODAY_15H_UTC + 1000;
    await scheduler(t).tick();
    expect((await row(t))?.statusText).toBe('livre');
  });

  it('a second temporary status keeps the original previous', async () => {
    const t = await setupTasks();
    await t.userService.updateStatusText(t.alice.id, 'no trampo');
    await applyStatus(t, 'Em reunião', TODAY_15H);
    await applyStatus(t, 'Almoçando', '2026-11-26T16:00');
    expect(await row(t)).toMatchObject({ statusText: 'Almoçando', statusTextPrevious: 'no trampo' });

    t.clock.now = Date.UTC(2026, 10, 26, 19, 1);
    await scheduler(t).tick();
    expect((await row(t))?.statusText).toBe('no trampo');
  });
});
