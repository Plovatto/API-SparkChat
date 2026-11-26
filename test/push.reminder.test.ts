import { describe, expect, it, vi } from 'vitest';
import { buildReminderPushPayload, reminderTopic, type PushSender } from '@/modules/push/index.js';
import { MAX_PUSH_PAYLOAD_BYTES } from '@/modules/push/push.types.js';
import { build, subscription } from './support/push-fixture.js';

async function withSubscription(options: Parameters<typeof build>[0] = {}) {
  const context = await build(options);
  await context.repository.save({
    id: 's1',
    userId: 'u1',
    sessionId: 's-u1',
    endpoint: subscription().endpoint,
    p256dh: 'x',
    auth: 'y',
    userAgent: null,
    nowIso: new Date().toISOString(),
  });
  return context;
}

describe('reminder push', () => {
  it('delivers a high urgency reminder payload even when a client is visible', async () => {
    const sender = vi.fn<PushSender>(() => Promise.resolve());
    const { service } = await withSubscription({ sender, connected: new Set(['u1']) });
    service.reminder({ userId: 'u1', reminderId: 'rem-1', text: 'beber água', roomId: 'room-1' });
    await service.idle();

    expect(sender).toHaveBeenCalledTimes(1);
    const [, payload, options] = sender.mock.calls[0] ?? [];
    expect(JSON.parse(payload as string)).toEqual({ t: 'reminder', id: 'rem-1', roomId: 'room-1', x: 'beber água' });
    expect(options).toEqual({ TTL: 3600, urgency: 'high', topic: reminderTopic('rem-1') });
    expect(options?.topic.length).toBeLessThanOrEqual(32);
    expect(options?.topic.startsWith('r-')).toBe(true);
  });

  it('truncates the text to fit the payload limit without splitting characters', () => {
    const payload = buildReminderPushPayload({ reminderId: 'rem-1', roomId: 'room-1', text: '😀'.repeat(2000) });
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
    expect(payload.t === 'reminder' && payload.x.length).toBeGreaterThan(100);
    expect(payload.t === 'reminder' && /^(😀)+$/.test(payload.x)).toBe(true);
  });

  it('rate limits reminders per user at 20 per minute', async () => {
    const sender = vi.fn<PushSender>(() => Promise.resolve());
    const { service } = await withSubscription({ sender });
    for (let index = 0; index < 25; index += 1) {
      service.reminder({ userId: 'u1', reminderId: `rem-${index}`, text: 'x', roomId: 'room-1' });
    }
    await service.idle();
    expect(sender).toHaveBeenCalledTimes(20);
  });

  it('sends nothing when push is disabled', async () => {
    const sender = vi.fn<PushSender>(() => Promise.resolve());
    const { service } = await withSubscription({ sender, publicKey: null });
    service.reminder({ userId: 'u1', reminderId: 'rem-1', text: 'x', roomId: 'room-1' });
    await service.idle();
    expect(sender).not.toHaveBeenCalled();
  });
});
