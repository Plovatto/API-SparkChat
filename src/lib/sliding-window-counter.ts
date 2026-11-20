export const DEFAULT_MAX_COUNTER_KEYS = 50_000;

export class SlidingWindowCounter {
  private readonly timestampsByKey = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly maxKeys: number = DEFAULT_MAX_COUNTER_KEYS,
  ) {}

  get size(): number {
    return this.timestampsByKey.size;
  }

  count(key: string): number {
    return this.pruneAndGet(key).length;
  }

  latest(key: string): number | undefined {
    return this.pruneAndGet(key).at(-1);
  }

  record(key: string): void {
    const recent = this.pruneAndGet(key);
    recent.push(Date.now());
    if (!this.timestampsByKey.has(key)) {
      this.makeRoom();
    }
    this.timestampsByKey.set(key, recent);
  }

  release(key: string): void {
    const recent = this.pruneAndGet(key);
    recent.pop();
    if (recent.length === 0) {
      this.timestampsByKey.delete(key);
    }
  }

  reset(key: string): void {
    this.timestampsByKey.delete(key);
  }

  sweep(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, timestamps] of this.timestampsByKey) {
      const last = timestamps.at(-1);
      if (last === undefined || last <= cutoff) {
        this.timestampsByKey.delete(key);
      }
    }
  }

  private makeRoom(): void {
    if (this.timestampsByKey.size < this.maxKeys) {
      return;
    }

    this.sweep();
    for (const key of this.timestampsByKey.keys()) {
      if (this.timestampsByKey.size < this.maxKeys) {
        return;
      }
      this.timestampsByKey.delete(key);
    }
  }

  private pruneAndGet(key: string): number[] {
    const existing = this.timestampsByKey.get(key);
    if (!existing) {
      return [];
    }

    const cutoff = Date.now() - this.windowMs;
    const pruned = existing.filter((timestamp) => timestamp > cutoff);

    if (pruned.length === 0) {
      this.timestampsByKey.delete(key);
    } else {
      this.timestampsByKey.set(key, pruned);
    }

    return pruned;
  }
}
