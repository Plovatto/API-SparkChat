import { and, eq, lt, sql } from 'drizzle-orm';
import { pushSubscriptions, sessions } from '../../database/schema.js';
import type { Database } from '../../database/turso-client.js';
import { MAX_SUBSCRIPTIONS_PER_USER, type ActivePushSubscription, type PushSubscriptionRecord } from './push.types.js';

export interface SavePushSubscription {
  id: string;
  userId: string;
  sessionId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  nowIso: string;
}

export class PushRepository {
  constructor(private readonly db: Database) {}

  async save(input: SavePushSubscription): Promise<void> {
    const keep = MAX_SUBSCRIPTIONS_PER_USER - 1;
    await this.db.batch([
      this.db.run(sql`
        DELETE FROM push_subscriptions
        WHERE id IN (
          SELECT id FROM push_subscriptions
          WHERE user_id = ${input.userId} AND endpoint <> ${input.endpoint}
          ORDER BY last_used_at DESC, created_at DESC, id DESC
          LIMIT -1 OFFSET ${keep}
        )
      `),
      this.db
        .insert(pushSubscriptions)
        .values({
          id: input.id,
          userId: input.userId,
          sessionId: input.sessionId,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
          userAgent: input.userAgent,
          createdAt: input.nowIso,
          lastUsedAt: input.nowIso,
        })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: {
            userId: input.userId,
            sessionId: input.sessionId,
            p256dh: input.p256dh,
            auth: input.auth,
            userAgent: input.userAgent,
            lastUsedAt: input.nowIso,
          },
        }),
    ]);
  }

  async deleteOwned(userId: string, endpoint: string): Promise<void> {
    await this.db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
  }

  async deleteById(id: string): Promise<void> {
    await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
  }

  async listForUser(userId: string): Promise<PushSubscriptionRecord[]> {
    return this.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  }

  async listActiveForUser(userId: string): Promise<ActivePushSubscription[]> {
    const rows = await this.db
      .select({ subscription: pushSubscriptions, sessionCreatedAt: sessions.createdAt, sessionLastUsedAt: sessions.lastUsedAt })
      .from(pushSubscriptions)
      .innerJoin(sessions, and(eq(sessions.id, pushSubscriptions.sessionId), eq(sessions.userId, pushSubscriptions.userId)))
      .where(eq(pushSubscriptions.userId, userId));
    return rows.map((row) => ({ ...row.subscription, session: { createdAt: row.sessionCreatedAt, lastUsedAt: row.sessionLastUsedAt } }));
  }

  async deleteOrphans(userId: string): Promise<void> {
    await this.db.run(sql`
      DELETE FROM push_subscriptions
      WHERE user_id = ${userId}
        AND session_id NOT IN (SELECT id FROM sessions WHERE user_id = ${userId})
    `);
  }

  async deleteForSession(userId: string, sessionId: string): Promise<void> {
    await this.db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.sessionId, sessionId)));
  }

  async touch(id: string, nowIso: string, staleBeforeIso: string): Promise<void> {
    await this.db
      .update(pushSubscriptions)
      .set({ lastUsedAt: nowIso })
      .where(and(eq(pushSubscriptions.id, id), lt(pushSubscriptions.lastUsedAt, staleBeforeIso)));
  }
}
