import { AI_DAILY_MESSAGE_LIMIT } from './ai.model.js';

function currentDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export class AiUsageLimiter {
  private readonly countByKey = new Map<string, number>();

  isBlocked(userId: string): boolean {
    return this.getUsed(userId) >= AI_DAILY_MESSAGE_LIMIT;
  }

  registerUsage(userId: string): void {
    const key = this.buildKey(userId);
    this.countByKey.set(key, this.getUsed(userId) + 1);
  }

  getRemaining(userId: string): number {
    return Math.max(0, AI_DAILY_MESSAGE_LIMIT - this.getUsed(userId));
  }

  private getUsed(userId: string): number {
    return this.countByKey.get(this.buildKey(userId)) ?? 0;
  }

  private buildKey(userId: string): string {
    return `${userId}:${currentDateKey()}`;
  }
}
