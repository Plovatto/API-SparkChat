const WINDOW_MS = 60_000;
const MAX_SUBSCRIPTION_CHANGES_PER_USER = 10;
const MAX_CALL_PUSHES_PER_USER = 20;
const MAX_MESSAGE_PUSHES_PER_USER = 30;
const MAX_REMINDER_PUSHES_PER_USER = 20;
const MESSAGE_ROOM_COOLDOWN_MS = 3_000;

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

  tryReminder(userId: string): boolean {
    return this.tryWindow(`reminder:${userId}`, MAX_REMINDER_PUSHES_PER_USER);
  }

  messageDelayMs(userId: string, roomId: string): number {
    const current = this.now();
    const last = this.roomCooldowns.get(`${userId}:${roomId}`);
    const cooldown = last === undefined ? 0 : Math.max(0, last + MESSAGE_ROOM_COOLDOWN_MS - current);
    const recent = (this.windows.get(`msg:${userId}`) ?? []).filter((timestamp) => timestamp > current - WINDOW_MS);
    const window = recent.length >= MAX_MESSAGE_PUSHES_PER_USER ? Math.max(0, (recent[0] ?? current) + WINDOW_MS - current + 1) : 0;
    return Math.max(cooldown, window);
  }

  tryMessage(userId: string, roomId: string): boolean {
    if (this.messageDelayMs(userId, roomId) > 0 || !this.tryWindow(`msg:${userId}`, MAX_MESSAGE_PUSHES_PER_USER)) {
      return false;
    }
    this.roomCooldowns.set(`${userId}:${roomId}`, this.now());
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
