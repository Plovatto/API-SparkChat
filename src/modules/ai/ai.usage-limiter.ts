import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { aiDailyUsage } from '../../database/schema.js';
import type { Database } from '../../database/turso-client.js';
import { AI_DAILY_MESSAGE_LIMIT } from './ai.model.js';

export function currentUsageDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export class AiUsageRepository {
  constructor(private readonly db: Database) {}

  async count(userId: string, usageDate: string): Promise<number> {
    const [row] = await this.db
      .select({ count: aiDailyUsage.count })
      .from(aiDailyUsage)
      .where(and(eq(aiDailyUsage.userId, userId), eq(aiDailyUsage.usageDate, usageDate)));
    return row?.count ?? 0;
  }

  async consume(userId: string, usageDate: string, limit: number): Promise<boolean> {
    const rows = await this.db
      .insert(aiDailyUsage)
      .values({ userId, usageDate, count: 1 })
      .onConflictDoUpdate({
        target: [aiDailyUsage.userId, aiDailyUsage.usageDate],
        set: { count: sql`${aiDailyUsage.count} + 1` },
        setWhere: lt(aiDailyUsage.count, limit),
      })
      .returning({ count: aiDailyUsage.count });
    return rows.length > 0;
  }

  async refund(userId: string, usageDate: string): Promise<void> {
    await this.db
      .update(aiDailyUsage)
      .set({ count: sql`${aiDailyUsage.count} - 1` })
      .where(and(eq(aiDailyUsage.userId, userId), eq(aiDailyUsage.usageDate, usageDate), gt(aiDailyUsage.count, 0)));
  }

  async purgeBefore(usageDate: string): Promise<void> {
    await this.db.delete(aiDailyUsage).where(lt(aiDailyUsage.usageDate, usageDate));
  }
}

export class AiUsageLimiter {
  constructor(
    private readonly repository: AiUsageRepository,
    private readonly limit: number = AI_DAILY_MESSAGE_LIMIT,
  ) {}

  async isBlocked(userId: string): Promise<boolean> {
    return (await this.repository.count(userId, currentUsageDate())) >= this.limit;
  }

  tryConsume(userId: string): Promise<boolean> {
    return this.repository.consume(userId, currentUsageDate(), this.limit);
  }

  refund(userId: string): Promise<void> {
    return this.repository.refund(userId, currentUsageDate());
  }
}
