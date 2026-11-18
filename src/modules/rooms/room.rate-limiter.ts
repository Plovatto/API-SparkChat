const MAX_JOIN_ATTEMPTS = 10;
const JOIN_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;
export const KEY_REQUEST_INTERVAL_MS = 30 * 1000;
const PENDING_KEY_REQUEST_TTL_MS = 2 * 60 * 1000;
const MAX_TRACKED_ENTRIES = 10_000;

function pruneExpired(entries: Map<string, number>, now: number): void {
  if (entries.size < MAX_TRACKED_ENTRIES) {
    return;
  }
  for (const [key, expiresAt] of entries) {
    if (expiresAt <= now) {
      entries.delete(key);
    }
  }
}

export class RoomActionRateLimiter {
  private readonly joinAttempts = new Map<string, number[]>();
  private readonly keyRequestCooldowns = new Map<string, number>();
  private readonly pendingKeyRequests = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  tryJoinAttempt(userId: string): boolean {
    const now = this.now();
    const recent = (this.joinAttempts.get(userId) ?? []).filter((timestamp) => timestamp > now - JOIN_ATTEMPT_WINDOW_MS);
    if (recent.length >= MAX_JOIN_ATTEMPTS) {
      this.joinAttempts.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.joinAttempts.set(userId, recent);
    return true;
  }

  forgiveJoinAttempt(userId: string): void {
    const recent = this.joinAttempts.get(userId);
    recent?.pop();
    if (recent?.length === 0) {
      this.joinAttempts.delete(userId);
    }
  }

  tryKeyRequest(userId: string, roomId: string): boolean {
    const now = this.now();
    const key = `${userId}:${roomId}`;
    pruneExpired(this.keyRequestCooldowns, now);
    pruneExpired(this.pendingKeyRequests, now);

    const cooldownUntil = this.keyRequestCooldowns.get(key);
    if (cooldownUntil !== undefined && cooldownUntil > now) {
      return false;
    }

    this.keyRequestCooldowns.set(key, now + KEY_REQUEST_INTERVAL_MS);
    this.pendingKeyRequests.set(key, now + PENDING_KEY_REQUEST_TTL_MS);
    return true;
  }

  hasPendingKeyRequest(userId: string, roomId: string): boolean {
    const expiresAt = this.pendingKeyRequests.get(`${userId}:${roomId}`);
    return expiresAt !== undefined && expiresAt > this.now();
  }

  consumePendingKeyRequest(userId: string, roomId: string): boolean {
    const key = `${userId}:${roomId}`;
    const expiresAt = this.pendingKeyRequests.get(key);
    this.pendingKeyRequests.delete(key);
    return expiresAt !== undefined && expiresAt > this.now();
  }
}
