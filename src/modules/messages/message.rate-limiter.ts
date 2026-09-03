const MAX_MESSAGES = 20;
const WINDOW_MS = 10 * 1000;

export class MessageRateLimiter {
  private readonly timestampsByUserId = new Map<string, number[]>();

  isBlocked(userId: string): boolean {
    return this.pruneAndGet(userId).length >= MAX_MESSAGES;
  }

  registerSend(userId: string): void {
    const recent = this.pruneAndGet(userId);
    recent.push(Date.now());
    this.timestampsByUserId.set(userId, recent);
  }

  private pruneAndGet(userId: string): number[] {
    const cutoff = Date.now() - WINDOW_MS;
    const existing = this.timestampsByUserId.get(userId) ?? [];
    const pruned = existing.filter((timestamp) => timestamp > cutoff);

    if (pruned.length === 0) {
      this.timestampsByUserId.delete(userId);
    } else {
      this.timestampsByUserId.set(userId, pruned);
    }

    return pruned;
  }
}
