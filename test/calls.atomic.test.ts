import { afterEach, describe, expect, it } from 'vitest';
import { CallRepository } from '@/modules/calls/index.js';
import { createTestDb } from './support/create-test-db.js';

const base = { roomId: 'r', kind: 'voice' as const, createdAt: '2026-06-15T12:00:00.000Z' };

describe('call repository atomic writes', () => {
  const dbs: Awaited<ReturnType<typeof createTestDb>>[] = [];

  afterEach(() => {
    dbs.length = 0;
  });

  async function repo(): Promise<CallRepository> {
    const db = await createTestDb();
    dbs.push(db);
    return new CallRepository(db);
  }

  it('inserts only one call when both sides race for each other', async () => {
    const calls = await repo();

    const results = await Promise.all([
      calls.insertIfBothFree({ ...base, id: 'a', callerId: 'u1', calleeId: 'u2' }),
      calls.insertIfBothFree({ ...base, id: 'b', callerId: 'u2', calleeId: 'u1' }),
      calls.insertIfBothFree({ ...base, id: 'c', callerId: 'u3', calleeId: 'u1' }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await calls.findOpen()).toHaveLength(1);
  });

  it('allows a new call once the previous one ended', async () => {
    const calls = await repo();
    expect(await calls.insertIfBothFree({ ...base, id: 'a', callerId: 'u1', calleeId: 'u2' })).toBe(true);
    expect(await calls.end('a', 'ringing', 'cancelled', base.createdAt)).not.toBeNull();
    expect(await calls.end('a', 'ringing', 'missed', base.createdAt)).toBeNull();
    expect(await calls.insertIfBothFree({ ...base, id: 'b', callerId: 'u2', calleeId: 'u1' })).toBe(true);
  });

  it('accepts once and never after the ring window', async () => {
    const calls = await repo();
    await calls.insertIfBothFree({ ...base, id: 'a', callerId: 'u1', calleeId: 'u2' });

    const attempts = await Promise.all(
      ['d1', 'd2', 'd3'].map((device) => calls.accept('a', 'u2', device, '2026-06-15T12:00:05.000Z', '2026-06-15T11:59:20.000Z')),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);

    await calls.insertIfBothFree({ ...base, id: 'late', callerId: 'u5', calleeId: 'u6' });
    expect(await calls.accept('late', 'u6', 'd', '2026-06-15T12:01:00.000Z', '2026-06-15T12:00:15.000Z')).toBeNull();
    expect(await calls.accept('late', 'u1', 'd', '2026-06-15T12:00:05.000Z', '2026-06-15T11:59:20.000Z')).toBeNull();
  });
});
