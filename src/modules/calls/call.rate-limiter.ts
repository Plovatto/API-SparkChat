const START_WINDOW_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_STARTS_PER_CALLER = 5;
const MAX_STARTS_PER_PAIR = 3;
const MAX_STARTS_PER_PAIR_PER_DAY = 30;
const SIGNAL_WINDOW_MS = 1000;
const MAX_SIGNALS_PER_WINDOW = 60;
const ICE_SERVERS_COOLDOWN_MS = 10_000;
const MAX_ICE_SERVERS_PER_USER = 10;
const ICE_SERVERS_REFILL_MS = 30 * 60 * 1000;
const ICE_SERVERS_RETENTION_MS = 5 * 60 * 60 * 1000;
const CLOSED_CALL_RETENTION_MS = 60_000;
const TRANSFER_WINDOW_MS = 60_000;
const MAX_TRANSFERS_PER_WINDOW = 3;

interface SignalWindow {
  startedAt: number;
  count: number;
}

interface IceServersUsage {
  firstAt: number;
  lastAt: number;
  count: number;
}

export class CallRateLimiter {
  private readonly callerStarts = new Map<string, number[]>();
  private readonly pairStarts = new Map<string, number[]>();
  private readonly signals = new Map<string, SignalWindow>();
  private readonly iceServers = new Map<string, IceServersUsage>();
  private readonly closed = new Map<string, number>();
  private readonly transfers = new Map<string, number[]>();
  private readonly iceBypass = new Map<string, string>();

  constructor(private readonly now: () => number = Date.now) {}

  tryStart(callerId: string, calleeId: string): boolean {
    const current = this.now();
    const callerKey = callerId;
    const pairKey = `${callerId}:${calleeId}`;
    const callerRecent = (this.callerStarts.get(callerKey) ?? []).filter((timestamp) => timestamp > current - START_WINDOW_MS);
    const pairDay = (this.pairStarts.get(pairKey) ?? []).filter((timestamp) => timestamp > current - DAY_MS);
    const pairRecent = pairDay.filter((timestamp) => timestamp > current - START_WINDOW_MS);
    if (
      callerRecent.length >= MAX_STARTS_PER_CALLER ||
      pairRecent.length >= MAX_STARTS_PER_PAIR ||
      pairDay.length >= MAX_STARTS_PER_PAIR_PER_DAY
    ) {
      return false;
    }
    this.callerStarts.set(callerKey, [...callerRecent, current]);
    this.pairStarts.set(pairKey, [...pairDay, current]);
    return true;
  }

  trySignal(callId: string): boolean {
    if (this.isClosed(callId)) {
      return false;
    }
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

  allowNextIceServers(callId: string, userId: string, socketId: string): void {
    this.iceBypass.set(`${callId}:${userId}`, socketId);
  }

  tryIceServers(callId: string, userId: string, socketId?: string): boolean {
    if (this.isClosed(callId)) {
      return false;
    }
    const key = `${callId}:${userId}`;
    if (socketId !== undefined && this.iceBypass.get(key) === socketId) {
      this.iceBypass.delete(key);
      const usage = this.iceServers.get(key);
      this.iceServers.set(key, { firstAt: usage?.firstAt ?? this.now(), lastAt: this.now(), count: usage?.count ?? 1 });
      return true;
    }
    const current = this.now();
    const usage = this.iceServers.get(key);
    const allowance = usage ? MAX_ICE_SERVERS_PER_USER + Math.floor((current - usage.firstAt) / ICE_SERVERS_REFILL_MS) : MAX_ICE_SERVERS_PER_USER;
    if (usage && (current - usage.lastAt < ICE_SERVERS_COOLDOWN_MS || usage.count >= allowance)) {
      return false;
    }
    this.iceServers.set(key, { firstAt: usage?.firstAt ?? current, lastAt: current, count: (usage?.count ?? 0) + 1 });
    return true;
  }

  tryTransfer(callId: string): boolean {
    if (this.isClosed(callId)) {
      return false;
    }
    const current = this.now();
    const recent = (this.transfers.get(callId) ?? []).filter((timestamp) => timestamp > current - TRANSFER_WINDOW_MS);
    if (recent.length >= MAX_TRANSFERS_PER_WINDOW) {
      return false;
    }
    this.transfers.set(callId, [...recent, current]);
    return true;
  }

  forgetCall(callId: string): void {
    this.signals.delete(callId);
    this.transfers.delete(callId);
    for (const key of this.iceBypass.keys()) {
      if (key.startsWith(`${callId}:`)) {
        this.iceBypass.delete(key);
      }
    }
    for (const key of this.iceServers.keys()) {
      if (key.startsWith(`${callId}:`)) {
        this.iceServers.delete(key);
      }
    }
    this.closed.set(callId, this.now() + CLOSED_CALL_RETENTION_MS);
  }

  purge(): void {
    const current = this.now();
    for (const [key, timestamps] of this.callerStarts) {
      if (!timestamps.some((timestamp) => timestamp > current - START_WINDOW_MS)) {
        this.callerStarts.delete(key);
      }
    }
    for (const [key, timestamps] of this.pairStarts) {
      if (!timestamps.some((timestamp) => timestamp > current - DAY_MS)) {
        this.pairStarts.delete(key);
      }
    }
    for (const [key, window] of this.signals) {
      if (current - window.startedAt >= SIGNAL_WINDOW_MS) {
        this.signals.delete(key);
      }
    }
    for (const [key, usage] of this.iceServers) {
      if (current - usage.lastAt >= ICE_SERVERS_RETENTION_MS) {
        this.iceServers.delete(key);
      }
    }
    for (const [key, expiresAt] of this.closed) {
      if (expiresAt <= current) {
        this.closed.delete(key);
      }
    }
  }

  size(): number {
    return this.callerStarts.size + this.pairStarts.size + this.signals.size + this.iceServers.size + this.closed.size;
  }

  private isClosed(callId: string): boolean {
    const expiresAt = this.closed.get(callId);
    return expiresAt !== undefined && expiresAt > this.now();
  }
}
