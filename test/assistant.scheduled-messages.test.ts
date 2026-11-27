import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { rooms, scheduledMessages } from '@/database/schema.js';
import type { AssistantCard } from '@/modules/assistant/assistant.card.js';
import { AssistantScheduler } from '@/modules/assistant/assistant.scheduler.js';
import { createScheduleMessageTool } from '@/modules/assistant/tools/scheduled.tools.js';
import { fakeField, newKeyId } from './support/room-keys.js';
import { TIME_ZONE, setupScheduling } from './support/assistant-tasks-fixture.js';

type Scheduling = Awaited<ReturnType<typeof setupScheduling>>;

const SEND_AT_LOCAL = '2026-11-27T09:00';
const SEND_AT = Date.UTC(2026, 10, 27, 12, 0);

async function proposeCard(t: Scheduling, args: Record<string, unknown> = {}) {
  const result = await t.toolbox.run('schedule_message', { recipient: 'bob', text: 'bom dia!', sendAtLocal: SEND_AT_LOCAL, ...args }, t.toolContext());
  const card = result.card as Extract<AssistantCard, { kind: 'confirm' }>;
  const message = await t.postCard(card);
  return { cardId: message.id, card, action: card.action as Extract<typeof card.action, { type: 'scheduled-message' }> };
}

function request(t: Scheduling, cardId: string, overrides: Partial<Parameters<Scheduling['scheduled']['schedule']>[0]> = {}) {
  return {
    io: t.io,
    userId: t.alice.id,
    cardId,
    roomId: t.bobRoom.id,
    sendAt: SEND_AT,
    messageId: randomUUID(),
    content: fakeField('bom dia!', t.bobKeyId),
    keyId: t.bobKeyId,
    locale: 'pt' as const,
    ...overrides,
  };
}

function schedulerFor(t: Scheduling) {
  const push = { reminder: vi.fn() };
  return new AssistantScheduler({ io: t.io, host: t.host, reminders: t.reminders, push, scheduled: t.scheduled, delivery: t.delivery }, t.now);
}

describe('schedule_message tool', () => {
  it('resolves the private room by nickname ignoring case and returns the confirm card with the server side sendAt', async () => {
    const t = await setupScheduling();
    const result = await t.toolbox.run('schedule_message', { recipient: '  BOB ', text: ' bom dia! ', sendAtLocal: SEND_AT_LOCAL }, t.toolContext());

    expect(result.card).toEqual({
      v: 1,
      kind: 'confirm',
      action: { type: 'scheduled-message', roomId: t.bobRoom.id, recipient: 'Bob', text: 'bom dia!', sendAtLocal: SEND_AT_LOCAL, timeZone: TIME_ZONE, sendAt: SEND_AT },
      buttons: [
        { choice: 'yes', label: 'Sim' },
        { choice: 'no', label: 'Não' },
      ],
    });
    expect(result.response).toMatchObject({ awaitingConfirmation: true });
    expect(String(result.response.summary)).toContain('Bob');
  });

  it('answers in English', async () => {
    const t = await setupScheduling();
    const result = await t.toolbox.run('schedule_message', { recipient: 'bob', text: 'hi', sendAtLocal: SEND_AT_LOCAL }, t.toolContext('en'));
    expect((result.card as Extract<AssistantCard, { kind: 'confirm' }>).buttons).toEqual([
      { choice: 'yes', label: 'Yes' },
      { choice: 'no', label: 'No' },
    ]);
  });

  it('returns ambiguous with the options when two private rooms share the nickname', async () => {
    const t = await setupScheduling();
    const tool = createScheduleMessageTool(t.scheduled, {
      listTargets: () =>
        Promise.resolve([
          { roomId: 'r1', nickname: 'Ana' },
          { roomId: 'r2', nickname: 'ana' },
          { roomId: 'r3', nickname: 'Carla' },
        ]),
    });
    const result = await tool.run({ recipient: 'ANA', text: 'oi', sendAtLocal: SEND_AT_LOCAL }, t.toolContext());
    expect(result.response).toEqual({ error: 'ambiguous', options: ['Ana', 'ana'] });
    expect(result.card).toBeUndefined();
  });

  it('never targets the SparkAI room or a blocked room', async () => {
    const t = await setupScheduling();
    const toAssistant = await t.toolbox.run('schedule_message', { recipient: 'Assistente', text: 'oi', sendAtLocal: SEND_AT_LOCAL }, t.toolContext());
    expect(toAssistant.response).toEqual({ error: 'recipient_not_found' });

    await t.roomService.blockUser(t.bobRoom.id, t.alice.id, t.bob.id);
    const blocked = await t.toolbox.run('schedule_message', { recipient: 'bob', text: 'oi', sendAtLocal: SEND_AT_LOCAL }, t.toolContext());
    expect(blocked.response).toEqual({ error: 'recipient_not_found' });
  });

  it('reports recipient_not_found, need_time, too_soon, too_far and too_long', async () => {
    const t = await setupScheduling();
    const run = async (args: Record<string, unknown>) => (await t.toolbox.run('schedule_message', { recipient: 'bob', text: 'oi', ...args }, t.toolContext())).response;

    expect(await run({ recipient: 'ninguem', sendAtLocal: SEND_AT_LOCAL })).toEqual({ error: 'recipient_not_found' });
    expect(await run({})).toEqual({ error: 'need_time' });
    expect(await run({ sendAtLocal: '2026-11-26T09:00' })).toEqual({ error: 'too_soon' });
    expect(await run({ sendAtLocal: '2028-01-01T09:00' })).toEqual({ error: 'too_far' });
    expect(await run({ text: 'a'.repeat(4001), sendAtLocal: SEND_AT_LOCAL })).toEqual({ error: 'too_long' });
  });
});

describe('scheduling a confirmed message', () => {
  it('stores a pending row, resolves the card as yes in the SparkAI room and confirms in words', async () => {
    const t = await setupScheduling();
    const { cardId } = await proposeCard(t);
    const input = request(t, cardId);

    expect(await t.scheduled.schedule(input)).toMatchObject({ ok: true });

    const [row] = await t.db.select().from(scheduledMessages);
    expect(row).toMatchObject({ userId: t.alice.id, roomId: t.bobRoom.id, messageId: input.messageId, sendAt: SEND_AT, status: 'pending', cardId });
    expect(row?.payload).toEqual({ content: input.content, type: 'text', keyId: t.bobKeyId });
    expect(row?.previewSealed).not.toContain('bom dia');
    expect(t.emitted).toContainEqual({ event: 'message:card-resolved', payload: { roomId: t.room.id, cardId, choice: 'yes' } });
    expect(await t.messageService.isCardResolved(cardId)).toBe(true);
    expect((await t.assistantTexts()).at(-1)).toMatch(/^Agendado ✅ Vou enviar pra Bob em /);
  });

  it('rejects a card id that does not exist, a resolved card, a card of another room and a non-assistant message', async () => {
    const t = await setupScheduling();
    expect(await t.scheduled.schedule(request(t, randomUUID()))).toEqual({ ok: false, error: 'not_allowed' });

    const { cardId } = await proposeCard(t);
    expect(await t.scheduled.schedule(request(t, cardId, { roomId: t.room.id }))).toEqual({ ok: false, error: 'not_allowed' });
    const forged = await t.sendFromAlice('forjado');
    expect(await t.scheduled.schedule(request(t, forged.id))).toEqual({ ok: false, error: 'not_allowed' });

    expect(await t.scheduled.schedule(request(t, cardId))).toMatchObject({ ok: true });
    expect(await t.scheduled.schedule(request(t, cardId))).toEqual({ ok: false, error: 'not_allowed' });
    expect(await t.db.select().from(scheduledMessages)).toHaveLength(1);
  });

  it('rejects confirm cards of another type and non-confirm cards', async () => {
    const t = await setupScheduling();
    const reminder = await t.postCard({
      v: 1,
      kind: 'confirm',
      action: { type: 'reminder', text: 'x', fireAtLocal: SEND_AT_LOCAL, timeZone: TIME_ZONE, recurrence: null },
      buttons: [],
    });
    expect(await t.scheduled.schedule(request(t, reminder.id))).toEqual({ ok: false, error: 'not_allowed' });
    const list = await t.postCard({ v: 1, kind: 'list', title: 'x', items: [] });
    expect(await t.scheduled.schedule(request(t, list.id))).toEqual({ ok: false, error: 'not_allowed' });
  });

  it('requires sendAt to match the card exactly and to stay inside the allowed window', async () => {
    const t = await setupScheduling();
    const { cardId } = await proposeCard(t);

    expect(await t.scheduled.schedule(request(t, cardId, { sendAt: SEND_AT + 1 }))).toEqual({ ok: false, error: 'not_allowed' });
    t.clock.now = SEND_AT - 10_000;
    expect(await t.scheduled.schedule(request(t, cardId))).toEqual({ ok: false, error: 'not_allowed' });
    expect(await t.db.select().from(scheduledMessages)).toHaveLength(0);
    expect(await t.messageService.isCardResolved(cardId)).toBe(false);
  });

  it('refuses a message id that already exists', async () => {
    const t = await setupScheduling();
    const { cardId } = await proposeCard(t);
    const existing = await t.sendFromAlice('oi');
    expect(await t.scheduled.schedule(request(t, cardId, { messageId: existing.id }))).toEqual({ ok: false, error: 'not_allowed' });
  });

  it('limits pending scheduled messages to 20 per user and leaves the card unresolved', async () => {
    const t = await setupScheduling();
    const proposals = [];
    for (let index = 0; index < 21; index += 1) {
      proposals.push(await proposeCard(t, { text: `msg ${index}` }));
    }
    for (const proposal of proposals.slice(0, 20)) {
      expect(await t.scheduled.schedule(request(t, proposal.cardId))).toMatchObject({ ok: true });
    }
    const last = proposals[20] as (typeof proposals)[number];
    expect(await t.scheduled.schedule(request(t, last.cardId))).toEqual({ ok: false, error: 'limit' });
    expect(await t.messageService.isCardResolved(last.cardId)).toBe(false);

    const tooMany = await t.toolbox.run('schedule_message', { recipient: 'bob', text: 'x', sendAtLocal: SEND_AT_LOCAL }, t.toolContext());
    expect(tooMany.response).toEqual({ error: 'limit' });
  });
});

describe('quick replies on scheduling cards', () => {
  it('a server side yes creates nothing and resolves nothing', async () => {
    const t = await setupScheduling();
    const { cardId } = await proposeCard(t);

    await t.tap(cardId, 'yes');

    expect(await t.db.select().from(scheduledMessages)).toHaveLength(0);
    expect(await t.messageService.isCardResolved(cardId)).toBe(false);
    expect(t.emitted.filter((event) => event.event === 'message:card-resolved')).toHaveLength(0);
  });

  it('no answers with the decline text and schedules nothing', async () => {
    const t = await setupScheduling();
    const { cardId } = await proposeCard(t);
    await t.tap(cardId, 'no');
    expect((await t.assistantTexts()).at(-1)).toBe('Ok, não vou agendar.');
    expect(await t.db.select().from(scheduledMessages)).toHaveLength(0);
  });

  it('send-now on a failed card only acknowledges', async () => {
    const t = await setupScheduling();
    const failed = await t.postCard({ v: 1, kind: 'scheduled-failed', roomId: t.bobRoom.id, text: 'oi', buttons: [{ choice: 'send-now', label: 'Enviar agora' }] });
    await t.tap(failed.id, 'send-now');
    expect((await t.assistantTexts()).at(-1)).toBe('Enviado! 📨');
  });
});

describe('list and cancel', () => {
  it('lists pending messages and cancels one after confirmation', async () => {
    const t = await setupScheduling();
    const { cardId } = await proposeCard(t);
    const scheduled = await t.scheduled.schedule(request(t, cardId));
    const id = (scheduled as { id: string }).id;

    const list = await t.toolbox.run('list_scheduled', {}, t.toolContext());
    expect(list.card).toMatchObject({ v: 1, kind: 'list', title: 'Mensagens agendadas', items: [{ id, text: 'bom dia!' }] });

    const cancel = await t.toolbox.run('cancel_scheduled', { id }, t.toolContext());
    expect(cancel.card).toMatchObject({ kind: 'confirm', action: { type: 'cancel-scheduled', scheduledId: id, preview: 'Bob: bom dia!' } });
    const message = await t.postCard(cancel.card as AssistantCard);
    await t.tap(message.id, 'yes');

    expect((await t.assistantTexts()).at(-1)).toBe('Agendamento cancelado.');
    expect((await t.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id)))[0]?.status).toBe('cancelled');
    expect((await t.toolbox.run('cancel_scheduled', { id: randomUUID() }, t.toolContext())).response).toEqual({ error: 'not_found' });
  });
});

describe('AssistantScheduler scheduled messages', () => {
  it('sends at the due time with the stored message id, broadcasts it and triggers the push hook once', async () => {
    const t = await setupScheduling();
    const { cardId } = await proposeCard(t);
    const input = request(t, cardId);
    await t.scheduled.schedule(input);
    const scheduler = schedulerFor(t);

    await scheduler.tick();
    expect(await t.messageService.getMessage(input.messageId)).toBeNull();

    t.clock.now = SEND_AT + 1000;
    await scheduler.tick();
    await scheduler.tick();

    const sent = await t.messageService.getMessage(input.messageId);
    expect(sent).toMatchObject({ senderId: t.alice.id, roomId: t.bobRoom.id, content: input.content, type: 'text' });
    expect(t.emitted.filter((event) => event.event === 'message:new' && (event.payload as { id: string }).id === input.messageId)).toHaveLength(1);
    expect(t.onMessageSent).toHaveBeenCalledTimes(1);
    expect(t.onMessageSent.mock.calls[0]?.[0]).toMatchObject({ room: { id: t.bobRoom.id }, message: { id: input.messageId } });
    expect((await t.db.select().from(scheduledMessages))[0]?.status).toBe('sent');
  });

  it('marks failed and posts the scheduled-failed card when the room key changed', async () => {
    const t = await setupScheduling();
    const { cardId } = await proposeCard(t);
    const input = request(t, cardId);
    await t.scheduled.schedule(input);
    await t.db.update(rooms).set({ currentKeyId: newKeyId() }).where(eq(rooms.id, t.bobRoom.id));

    t.clock.now = SEND_AT + 1000;
    await schedulerFor(t).tick();

    expect(await t.messageService.getMessage(input.messageId)).toBeNull();
    expect(t.onMessageSent).not.toHaveBeenCalled();
    expect((await t.db.select().from(scheduledMessages))[0]).toMatchObject({ status: 'failed', failureReason: 'stale_room_key' });
    const messages = (await t.messageService.getRoomMessagesPage(t.room.id, { limit: 50 })).messages.filter((item) => item.senderId === t.assistant.id);
    const card = await t.aiService.openCard(t.room.id, messages.at(-1) as NonNullable<(typeof messages)[number]>);
    expect(card).toEqual({
      v: 1,
      kind: 'scheduled-failed',
      roomId: t.bobRoom.id,
      text: 'bom dia!',
      buttons: [{ choice: 'send-now', label: 'Enviar agora' }],
    });
    expect((await t.assistantTexts()).at(-1)).toContain('Bob');
  });

  it('fails with the rotation reason when the room requires a new key', async () => {
    const t = await setupScheduling();
    const { cardId } = await proposeCard(t);
    await t.scheduled.schedule(request(t, cardId));
    await t.db.update(rooms).set({ rotationRequired: 2 }).where(eq(rooms.id, t.bobRoom.id));

    t.clock.now = SEND_AT + 1000;
    await schedulerFor(t).tick();

    expect((await t.db.select().from(scheduledMessages))[0]).toMatchObject({ status: 'failed', failureReason: 'stale_room_key' });
  });

  it('does not send cancelled messages and isolates a failing row from the others', async () => {
    const t = await setupScheduling();
    const first = await proposeCard(t, { text: 'um' });
    const second = await proposeCard(t, { text: 'dois' });
    const inputOne = request(t, first.cardId);
    const inputTwo = request(t, second.cardId);
    const scheduledOne = (await t.scheduled.schedule(inputOne)) as { id: string };
    await t.scheduled.schedule(inputTwo);
    await t.scheduled.cancel(t.alice.id, scheduledOne.id);
    const failing = vi.spyOn(t.delivery, 'send').mockRejectedValueOnce(new Error('boom'));

    t.clock.now = SEND_AT + 1000;
    await schedulerFor(t).tick();

    expect(failing).toHaveBeenCalledTimes(1);
    expect(await t.messageService.getMessage(inputOne.messageId)).toBeNull();
    const rows = await t.db.select().from(scheduledMessages);
    expect(rows.find((row) => row.messageId === inputTwo.messageId)).toMatchObject({ status: 'failed', failureReason: 'error' });
  });
});

describe('delivery safety', () => {
  async function scheduleOne(t: Scheduling) {
    const { cardId } = await proposeCard(t);
    const input = request(t, cardId);
    const result = (await t.scheduled.schedule(input)) as { id: string };
    return { input, id: result.id };
  }

  it('requeues a row stuck in sending when the message was never stored and sends it', async () => {
    const t = await setupScheduling();
    const { input, id } = await scheduleOne(t);
    await t.db.update(scheduledMessages).set({ status: 'sending', claimedAt: SEND_AT }).where(eq(scheduledMessages.id, id));

    t.clock.now = SEND_AT + 3 * 60_000;
    await schedulerFor(t).tick();

    expect(await t.messageService.getMessage(input.messageId)).not.toBeNull();
    expect((await t.db.select().from(scheduledMessages))[0]?.status).toBe('sent');
    expect(t.onMessageSent).toHaveBeenCalledTimes(1);
  });

  it('does not recover a row that was already late when claimed, even long after its send time', async () => {
    const t = await setupScheduling();
    const { input } = await scheduleOne(t);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = t.delivery.send.bind(t.delivery);
    const slow = vi.spyOn(t.delivery, 'send').mockImplementationOnce(async (io, item) => {
      await gate;
      return original(io, item);
    });

    t.clock.now = SEND_AT + 10 * 60_000;
    const first = schedulerFor(t).tick();
    await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(1));
    await schedulerFor(t).tick();
    expect(slow).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(await t.messageService.getMessage(input.messageId)).not.toBeNull();
    expect(t.onMessageSent).toHaveBeenCalledTimes(1);
    expect((await t.db.select().from(scheduledMessages))[0]?.status).toBe('sent');
  });

  it('treats a duplicate message id error from the send as already sent', async () => {
    const t = await setupScheduling();
    const { input } = await scheduleOne(t);
    const [item] = await t.scheduled.listPending(t.alice.id);
    vi.spyOn(t.messageService, 'sendMessage').mockImplementationOnce(() => {
      return Promise.reject(new Error('duplicate'));
    });
    vi.spyOn(t.messageService, 'getMessage').mockResolvedValueOnce(null).mockResolvedValue({ id: input.messageId } as never);

    expect(await t.delivery.send(t.io, item as NonNullable<typeof item>)).toEqual({ kind: 'sent' });
  });

  it('does not touch a row in sending that is still recent', async () => {
    const t = await setupScheduling();
    const { input, id } = await scheduleOne(t);
    await t.db.update(scheduledMessages).set({ status: 'sending', claimedAt: SEND_AT }).where(eq(scheduledMessages.id, id));

    t.clock.now = SEND_AT + 60_000;
    await schedulerFor(t).tick();

    expect(await t.messageService.getMessage(input.messageId)).toBeNull();
    expect((await t.db.select().from(scheduledMessages))[0]?.status).toBe('sending');
  });

  it('marks a stuck row as sent without resending when the message already exists', async () => {
    const t = await setupScheduling();
    const { input, id } = await scheduleOne(t);
    await t.messageService.sendMessage({ roomId: t.bobRoom.id, senderId: t.alice.id, content: input.content, messageId: input.messageId });
    await t.db.update(scheduledMessages).set({ status: 'sending', claimedAt: SEND_AT }).where(eq(scheduledMessages.id, id));

    t.clock.now = SEND_AT + 3 * 60_000;
    await schedulerFor(t).tick();

    expect((await t.db.select().from(scheduledMessages))[0]?.status).toBe('sent');
    expect(t.onMessageSent).not.toHaveBeenCalled();
    expect(t.emitted.filter((event) => event.event === 'message:new' && (event.payload as { id: string }).id === input.messageId)).toHaveLength(0);
  });

  it('delivery is idempotent: an existing message id returns sent without a failed card', async () => {
    const t = await setupScheduling();
    const { input } = await scheduleOne(t);
    await t.messageService.sendMessage({ roomId: t.bobRoom.id, senderId: t.alice.id, content: input.content, messageId: input.messageId });
    await t.db.update(rooms).set({ currentKeyId: newKeyId() }).where(eq(rooms.id, t.bobRoom.id));
    const [item] = await t.scheduled.listPending(t.alice.id);

    expect(await t.delivery.send(t.io, item as NonNullable<typeof item>)).toEqual({ kind: 'sent' });
  });

  it('rejects two concurrent requests for the same card with a single row and no raw error', async () => {
    const t = await setupScheduling();
    const { cardId } = await proposeCard(t);

    const results = await Promise.all([t.scheduled.schedule(request(t, cardId)), t.scheduled.schedule(request(t, cardId))]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toEqual({ ok: false, error: 'not_allowed' });
    expect(await t.db.select().from(scheduledMessages)).toHaveLength(1);
  });

  it('posts the failure without a send-now button when the preview cannot be opened', async () => {
    const t = await setupScheduling();
    const { id } = await scheduleOne(t);
    await t.db.update(scheduledMessages).set({ previewSealed: 'corrupt' }).where(eq(scheduledMessages.id, id));
    await t.db.update(rooms).set({ currentKeyId: newKeyId() }).where(eq(rooms.id, t.bobRoom.id));

    t.clock.now = SEND_AT + 1000;
    await schedulerFor(t).tick();

    const messages = (await t.messageService.getRoomMessagesPage(t.room.id, { limit: 50 })).messages.filter((item) => item.senderId === t.assistant.id);
    expect(messages.at(-1)?.assistantCard).toBeUndefined();
    expect((await t.assistantTexts()).at(-1)).toContain('Não consegui enviar');
    expect((await t.db.select().from(scheduledMessages))[0]).toMatchObject({ status: 'failed' });
  });

  it('cancel_scheduled only finds pending items', async () => {
    const t = await setupScheduling();
    const { id } = await scheduleOne(t);
    await t.scheduled.cancel(t.alice.id, id);
    expect((await t.toolbox.run('cancel_scheduled', { id }, t.toolContext())).response).toEqual({ error: 'not_found' });
  });
});
