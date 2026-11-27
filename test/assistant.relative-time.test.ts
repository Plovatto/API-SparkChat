import { describe, expect, it } from 'vitest';
import { AssistantToolbox, type AssistantContext } from '@/modules/assistant/assistant.toolbox.js';
import { resolveLocalTime } from '@/modules/assistant/relative-time.js';
import { createCreateReminderTool } from '@/modules/assistant/tools/reminder.tools.js';
import { createScheduleMessageTool } from '@/modules/assistant/tools/scheduled.tools.js';
import { createSetStatusTool } from '@/modules/assistant/tools/status.tool.js';

const NOW = Date.UTC(2026, 10, 26, 1, 34, 20);
const CTX: AssistantContext = { userId: 'u', roomId: 'r', locale: 'pt', io: {} as never, timeZone: 'America/Sao_Paulo', now: NOW };

function toolbox() {
  const directory = { listTargets: () => Promise.resolve([{ roomId: 'room-bia', nickname: 'Bia' }]) };
  return new AssistantToolbox()
    .register(createCreateReminderTool())
    .register(createSetStatusTool())
    .register(createScheduleMessageTool({ countPending: () => Promise.resolve(0) }, directory));
}

describe('relative times computed by the server', () => {
  it('floors minutes to the local wall time unless that is under a minute ahead', () => {
    expect(resolveLocalTime(undefined, 2, CTX)).toEqual({ local: '2026-11-25T22:36' });
    expect(resolveLocalTime(undefined, 1, { ...CTX, now: Date.UTC(2026, 10, 26, 1, 34, 50) })).toEqual({ local: '2026-11-25T22:36' });
    expect(resolveLocalTime(undefined, 2, { ...CTX, now: Date.UTC(2026, 10, 26, 1, 34, 0) })).toEqual({ local: '2026-11-25T22:36' });
  });

  it('rejects both or neither of local and relative', () => {
    expect(resolveLocalTime('2026-11-26T09:00', 5, CTX)).toEqual({ error: 'invalid_time' });
    expect(resolveLocalTime(undefined, undefined, CTX)).toEqual({ error: 'need_time' });
    expect(resolveLocalTime('garbage', undefined, CTX)).toEqual({ error: 'invalid_time' });
  });

  it('create_reminder with inMinutes builds the confirm card at 22:36 when it is 22:34', async () => {
    const now = Date.UTC(2026, 10, 26, 1, 34, 0);
    const result = await toolbox().run('create_reminder', { text: 'água', inMinutes: 2 }, { ...CTX, now });
    expect(result.response).toMatchObject({ awaitingConfirmation: true });
    expect(JSON.stringify(result.card)).toContain('2026-11-25T22:36');
  });

  it('set_status with untilInMinutes and schedule_message with inMinutes use the computed time', async () => {
    const status = await toolbox().run('set_status', { text: 'Em reunião', untilInMinutes: 90 }, CTX);
    expect(JSON.stringify(status.card)).toContain('2026-11-26T00:04');
    const scheduled = await toolbox().run('schedule_message', { recipient: 'Bia', text: 'oi', inMinutes: 120 }, CTX);
    expect(JSON.stringify(scheduled.card)).toContain('2026-11-26T00:34');
    expect(JSON.stringify(scheduled.card)).toContain(String(Math.floor((NOW + 120 * 60_000) / 60_000) * 60_000));
  });

  it('rejects out-of-range values and mixed parameters in every tool', async () => {
    const box = toolbox();
    for (const bad of [0, -1, 1.5, 525601]) {
      expect((await box.run('create_reminder', { text: 'x', inMinutes: bad }, CTX)).response).toEqual({ error: 'invalid_args' });
    }
    expect((await box.run('create_reminder', { text: 'x', inMinutes: 5, whenLocal: '2026-11-26T09:00' }, CTX)).response).toEqual({ error: 'invalid_time' });
    expect((await box.run('set_status', { text: 'x', untilInMinutes: 5, untilLocal: '2026-11-26T09:00' }, CTX)).response).toEqual({ error: 'invalid_time' });
    expect((await box.run('schedule_message', { recipient: 'Bia', text: 'x', inMinutes: 5, sendAtLocal: '2026-11-26T09:00' }, CTX)).response).toEqual({ error: 'invalid_time' });
  });
});
