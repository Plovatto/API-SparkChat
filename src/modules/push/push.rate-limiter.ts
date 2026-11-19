const WINDOW_MS = 60_000;
const MAX_SUBSCRIPTION_CHANGES_PER_USER = 10;
const MAX_CALL_PUSHES_PER_USER = 20;
const MAX_MESSAGE_PUSHES_PER_USER = 30;
const MESSAGE_ROOM_COOLDOWN_MS = 10_000;

export class PushRateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly roomCooldowns = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  trySubscriptionChange(userId: string): boolean {
    return this.tryWindow(`sub:${userId}`, MAX_SUBSCRIPTION_CHANGES_PER_USER);
  }

  tryCall(userId: string): boolean {
    return this.tryWindow(`call:${userId}`, MAX_CALL_PUSHES_PER_USER);
  }

  tryMessage(userId: string, roomId: string): boolean {
    const current = this.now();
    const roomKey = `${userId}:${roomId}`;
    const last = this.roomCooldowns.get(roomKey);
    if (last !== undefined && current - last < MESSAGE_ROOM_COOLDOWN_MS) {
      return false;
    }
    if (!this.tryWindow(`msg:${userId}`, MAX_MESSAGE_PUSHES_PER_USER)) {
      return false;
    }
    this.roomCooldowns.set(roomKey, current);
    return true;
  }

  purge(): void {
    const current = this.now();
    for (const [key, timestamps] of this.windows) {
      if (!timestamps.some((timestamp) => timestamp > current - WINDOW_MS)) {
        this.windows.delete(key);
      }
    }
    for (const [key, last] of this.roomCooldowns) {
      if (current - last >= MESSAGE_ROOM_COOLDOWN_MS) {
        this.roomCooldowns.delete(key);
      }
    }
  }

  private tryWindow(key: string, max: number): boolean {
    const current = this.now();
    const recent = (this.windows.get(key) ?? []).filter((timestamp) => timestamp > current - WINDOW_MS);
    if (recent.length >= max) {
      this.windows.set(key, recent);
      return false;
    }
    recent.push(current);
    this.windows.set(key, recent);
    return true;
  }
}
