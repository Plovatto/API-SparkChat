const MAX_JOIN_ATTEMPTS = 10;
const JOIN_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;
const MAX_GROUP_CREATIONS = 10;
const GROUP_CREATION_WINDOW_MS = 60 * 60 * 1000;
export const KEY_REQUEST_INTERVAL_MS = 30 * 1000;
export const INVITE_RESET_INTERVAL_MS = 30 * 1000;
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
  private readonly groupCreations = new Map<string, number[]>();
  private readonly keyRequestCooldowns = new Map<string, number>();
  private readonly inviteResetCooldowns = new Map<string, number>();

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

  tryCreateGroup(userId: string): boolean {
    const now = this.now();
    const recent = (this.groupCreations.get(userId) ?? []).filter((timestamp) => timestamp > now - GROUP_CREATION_WINDOW_MS);
    if (recent.length >= MAX_GROUP_CREATIONS) {
      this.groupCreations.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.groupCreations.set(userId, recent);
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
    return this.tryCooldown(this.keyRequestCooldowns, `${userId}:${roomId}`, KEY_REQUEST_INTERVAL_MS);
  }

  tryInviteReset(userId: string, roomId: string): boolean {
    return this.tryCooldown(this.inviteResetCooldowns, `${userId}:${roomId}`, INVITE_RESET_INTERVAL_MS);
  }

  private tryCooldown(cooldowns: Map<string, number>, key: string, intervalMs: number): boolean {
    const now = this.now();
    pruneExpired(cooldowns, now);

    const cooldownUntil = cooldowns.get(key);
    if (cooldownUntil !== undefined && cooldownUntil > now) {
      return false;
    }

    cooldowns.set(key, now + intervalMs);
    return true;
  }
}
