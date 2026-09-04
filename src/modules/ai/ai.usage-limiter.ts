import { AI_DAILY_MESSAGE_LIMIT } from './ai.model.js';

function currentDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export class AiUsageLimiter {
  private readonly countByUserId = new Map<string, number>();
  private dateKey = currentDateKey();

  isBlocked(userId: string): boolean {
    this.rolloverIfNeeded();
    return (this.countByUserId.get(userId) ?? 0) >= AI_DAILY_MESSAGE_LIMIT;
  }

  registerUsage(userId: string): void {
    this.rolloverIfNeeded();
    this.countByUserId.set(userId, (this.countByUserId.get(userId) ?? 0) + 1);
  }

  private rolloverIfNeeded(): void {
    const today = currentDateKey();
    if (today !== this.dateKey) {
      this.dateKey = today;
      this.countByUserId.clear();
    }
  }
}
