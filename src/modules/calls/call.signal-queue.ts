import type { CallRole } from './call.types.js';

export const SIGNAL_QUEUE_TTL_MS = 15_000;
export const SIGNAL_QUEUE_LIMIT = 64;

export interface QueuedSignalPayload {
  callId: string;
  from: string;
  envelope: string;
}

interface QueuedSignal {
  role: CallRole;
  at: number;
  payload: QueuedSignalPayload;
}

export class SignalQueue {
  private readonly queues = new Map<string, QueuedSignal[]>();

  enqueue(callId: string, role: CallRole, payload: QueuedSignalPayload, now: number): void {
    const fresh = (this.queues.get(callId) ?? []).filter((entry) => now - entry.at < SIGNAL_QUEUE_TTL_MS);
    if (fresh.length < SIGNAL_QUEUE_LIMIT) {
      fresh.push({ role, at: now, payload });
    }
    this.queues.set(callId, fresh);
  }

  take(callId: string, role: CallRole, now: number): QueuedSignalPayload[] {
    const queue = this.queues.get(callId);
    if (!queue) {
      return [];
    }
    const isFresh = (entry: QueuedSignal) => now - entry.at < SIGNAL_QUEUE_TTL_MS;
    const taken = queue.filter((entry) => entry.role === role && isFresh(entry)).map((entry) => entry.payload);
    this.store(callId, queue.filter((entry) => entry.role !== role && isFresh(entry)));
    return taken;
  }

  drop(callId: string, role: CallRole): void {
    const queue = this.queues.get(callId);
    if (queue) {
      this.store(callId, queue.filter((entry) => entry.role !== role));
    }
  }

  delete(callId: string): void {
    this.queues.delete(callId);
  }

  private store(callId: string, rest: QueuedSignal[]): void {
    if (rest.length === 0) {
      this.queues.delete(callId);
    } else {
      this.queues.set(callId, rest);
    }
  }
}
