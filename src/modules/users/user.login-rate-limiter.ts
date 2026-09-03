const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function buildKey(nickname: string, ip: string): string {
  return `${nickname.trim().toLowerCase()}:${ip}`;
}

function buildKeyfileKey(ip: string): string {
  return `keyfile:${ip}`;
}

export class LoginRateLimiter {
  private readonly failuresByKey = new Map<string, number[]>();

  isBlocked(nickname: string, ip: string): boolean {
    return this.isBlockedForKey(buildKey(nickname, ip));
  }

  registerFailure(nickname: string, ip: string): void {
    this.registerFailureForKey(buildKey(nickname, ip));
  }

  registerSuccess(nickname: string, ip: string): void {
    this.failuresByKey.delete(buildKey(nickname, ip));
  }

  isBlockedByIp(ip: string): boolean {
    return this.isBlockedForKey(buildKeyfileKey(ip));
  }

  registerFailureByIp(ip: string): void {
    this.registerFailureForKey(buildKeyfileKey(ip));
  }

  registerSuccessByIp(ip: string): void {
    this.failuresByKey.delete(buildKeyfileKey(ip));
  }

  private isBlockedForKey(key: string): boolean {
    return this.pruneAndGet(key).length >= MAX_ATTEMPTS;
  }

  private registerFailureForKey(key: string): void {
    const recent = this.pruneAndGet(key);
    recent.push(Date.now());
    this.failuresByKey.set(key, recent);
  }

  private pruneAndGet(key: string): number[] {
    const cutoff = Date.now() - WINDOW_MS;
    const existing = this.failuresByKey.get(key) ?? [];
    const pruned = existing.filter((timestamp) => timestamp > cutoff);

    if (pruned.length === 0) {
      this.failuresByKey.delete(key);
    } else {
      this.failuresByKey.set(key, pruned);
    }

    return pruned;
  }
}
