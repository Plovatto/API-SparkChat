const START_WINDOW_MS = 60_000;
const MAX_STARTS_PER_CALLER = 5;
const MAX_STARTS_PER_PAIR = 3;
const SIGNAL_WINDOW_MS = 1000;
const MAX_SIGNALS_PER_WINDOW = 60;
const ICE_SERVERS_COOLDOWN_MS = 10_000;
const MAX_ICE_SERVERS_PER_USER = 5;

interface SignalWindow {
  startedAt: number;
  count: number;
}

interface IceServersUsage {
  lastAt: number;
  count: number;
}

export class CallRateLimiter {
  private readonly starts = new Map<string, number[]>();
  private readonly signals = new Map<string, SignalWindow>();
  private readonly iceServers = new Map<string, IceServersUsage>();

  constructor(private readonly now: () => number = Date.now) {}

  tryStart(callerId: string, calleeId: string): boolean {
    const callerKey = `caller:${callerId}`;
    const pairKey = `pair:${callerId}:${calleeId}`;
    const callerRecent = this.recent(callerKey);
    const pairRecent = this.recent(pairKey);
    if (callerRecent.length >= MAX_STARTS_PER_CALLER || pairRecent.length >= MAX_STARTS_PER_PAIR) {
      return false;
    }
    const current = this.now();
    this.starts.set(callerKey, [...callerRecent, current]);
    this.starts.set(pairKey, [...pairRecent, current]);
    return true;
  }

  trySignal(callId: string): boolean {
    const current = this.now();
    const window = this.signals.get(callId);
    if (!window || current - window.startedAt >= SIGNAL_WINDOW_MS) {
      this.signals.set(callId, { startedAt: current, count: 1 });
      return true;
    }
    if (window.count >= MAX_SIGNALS_PER_WINDOW) {
      return false;
    }
    window.count += 1;
    return true;
  }

  tryIceServers(callId: string, userId: string): boolean {
    const key = `${callId}:${userId}`;
    const current = this.now();
    const usage = this.iceServers.get(key);
    if (usage && (current - usage.lastAt < ICE_SERVERS_COOLDOWN_MS || usage.count >= MAX_ICE_SERVERS_PER_USER)) {
      return false;
    }
    this.iceServers.set(key, { lastAt: current, count: (usage?.count ?? 0) + 1 });
    return true;
  }

  forgetCall(callId: string): void {
    this.signals.delete(callId);
    for (const key of this.iceServers.keys()) {
      if (key.startsWith(`${callId}:`)) {
        this.iceServers.delete(key);
      }
    }
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - START_WINDOW_MS;
    const kept = (this.starts.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (kept.length === 0) {
      this.starts.delete(key);
    } else {
      this.starts.set(key, kept);
    }
    return kept;
  }
}
