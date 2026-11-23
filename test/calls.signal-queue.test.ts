import { describe, expect, it } from 'vitest';
import { SIGNAL_QUEUE_LIMIT, SIGNAL_QUEUE_TTL_MS, SignalQueue } from '@/modules/calls/call.signal-queue.js';

const payload = (envelope: string) => ({ callId: 'c1', from: 'u1', envelope });

describe('SignalQueue', () => {
  it('returns queued signals for the role in order and keeps the other role', () => {
    const queue = new SignalQueue();
    queue.enqueue('c1', 'callee', payload('a'), 0);
    queue.enqueue('c1', 'caller', payload('b'), 1);
    queue.enqueue('c1', 'callee', payload('c'), 2);
    expect(queue.take('c1', 'callee', 3).map((p) => p.envelope)).toEqual(['a', 'c']);
    expect(queue.take('c1', 'callee', 3)).toEqual([]);
    expect(queue.take('c1', 'caller', 3).map((p) => p.envelope)).toEqual(['b']);
  });

  it('skips and discards expired entries on take', () => {
    const queue = new SignalQueue();
    queue.enqueue('c1', 'callee', payload('old'), 0);
    queue.enqueue('c1', 'caller', payload('old-peer'), 0);
    queue.enqueue('c1', 'callee', payload('new'), SIGNAL_QUEUE_TTL_MS - 1);
    expect(queue.take('c1', 'callee', SIGNAL_QUEUE_TTL_MS).map((p) => p.envelope)).toEqual(['new']);
    expect(queue.take('c1', 'caller', SIGNAL_QUEUE_TTL_MS)).toEqual([]);
  });

  it('caps fresh entries per call and prunes expired ones on enqueue', () => {
    const queue = new SignalQueue();
    for (let i = 0; i < SIGNAL_QUEUE_LIMIT + 5; i += 1) {
      queue.enqueue('c1', 'callee', payload(String(i)), 0);
    }
    expect(queue.take('c1', 'callee', 1)).toHaveLength(SIGNAL_QUEUE_LIMIT);
    for (let i = 0; i < SIGNAL_QUEUE_LIMIT; i += 1) {
      queue.enqueue('c1', 'callee', payload('stale'), 0);
    }
    queue.enqueue('c1', 'callee', payload('fresh'), SIGNAL_QUEUE_TTL_MS);
    expect(queue.take('c1', 'callee', SIGNAL_QUEUE_TTL_MS).map((p) => p.envelope)).toEqual(['fresh']);
  });

  it('drops only one role, ignoring expiry, and deletes whole calls', () => {
    const queue = new SignalQueue();
    queue.enqueue('c1', 'callee', payload('a'), 0);
    queue.enqueue('c1', 'caller', payload('b'), 0);
    queue.enqueue('c2', 'callee', payload('x'), 0);
    queue.drop('c1', 'callee');
    expect(queue.take('c1', 'callee', 1)).toEqual([]);
    expect(queue.take('c1', 'caller', 1).map((p) => p.envelope)).toEqual(['b']);
    queue.delete('c2');
    expect(queue.take('c2', 'callee', 1)).toEqual([]);
  });
});
