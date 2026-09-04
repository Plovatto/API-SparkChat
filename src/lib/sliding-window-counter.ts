export class SlidingWindowCounter {
  private readonly timestampsByKey = new Map<string, number[]>();

  constructor(private readonly windowMs: number) {}

  count(key: string): number {
    return this.pruneAndGet(key).length;
  }

  record(key: string): void {
    const recent = this.pruneAndGet(key);
    recent.push(Date.now());
    this.timestampsByKey.set(key, recent);
  }

  reset(key: string): void {
    this.timestampsByKey.delete(key);
  }

  private pruneAndGet(key: string): number[] {
    const cutoff = Date.now() - this.windowMs;
    const existing = this.timestampsByKey.get(key) ?? [];
    const pruned = existing.filter((timestamp) => timestamp > cutoff);

    if (pruned.length === 0) {
      this.timestampsByKey.delete(key);
    } else {
      this.timestampsByKey.set(key, pruned);
    }

    return pruned;
  }
}
