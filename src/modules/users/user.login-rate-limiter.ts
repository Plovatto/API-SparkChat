const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

const MAX_REGISTER_ATTEMPTS = 10;

function buildKey(nickname: string, ip: string): string {
  return `${nickname.trim().toLowerCase()}:${ip}`;
}

function buildKeyfileKey(ip: string): string {
  return `keyfile:${ip}`;
}

function buildRegisterKey(ip: string): string {
  return `register:${ip}`;
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

  isBlockedForRegistration(ip: string): boolean {
    return this.isBlockedForKey(buildRegisterKey(ip), MAX_REGISTER_ATTEMPTS);
  }

  registerAttemptForRegistration(ip: string): void {
    this.registerFailureForKey(buildRegisterKey(ip));
  }

  private isBlockedForKey(key: string, maxAttempts: number = MAX_ATTEMPTS): boolean {
    return this.pruneAndGet(key).length >= maxAttempts;
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
