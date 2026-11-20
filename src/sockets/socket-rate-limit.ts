import { logger } from '../config/logger.js';
import { errorPayload } from '../lib/app-error.js';
import type { AppSocket } from './events.js';

export interface EventBudget {
  capacity: number;
  refillPerSecond: number;
}

export interface SocketEventBudgets {
  events: Readonly<Record<string, EventBudget>>;
  fallback: EventBudget;
}

const frequent: EventBudget = { capacity: 60, refillPerSecond: 10 };
const keyExchange: EventBudget = { capacity: 300, refillPerSecond: 30 };
const roomAction: EventBudget = { capacity: 20, refillPerSecond: 2 };
const accountAction: EventBudget = { capacity: 20, refillPerSecond: 1 };
const profileKeyAction: EventBudget = { capacity: 20, refillPerSecond: 1 };

export const DEFAULT_SOCKET_EVENT_BUDGETS: SocketEventBudgets = {
  events: {
    'call:start': roomAction,
    'call:accept': roomAction,
    'call:decline': roomAction,
    'call:silence': roomAction,
    'call:hangup': roomAction,
    'call:signal': { capacity: 200, refillPerSecond: 60 },
    'call:heartbeat': { capacity: 20, refillPerSecond: 1 },
    'call:sync': roomAction,
    'call:ice-servers': roomAction,
    'call:transfer': roomAction,
    'call:transfer-accept': roomAction,
    'push:config': accountAction,
    'push:subscribe': accountAction,
    'push:unsubscribe': accountAction,
    'message:send': { capacity: 30, refillPerSecond: 5 },
    'message:mark-read': frequent,
    'messages:get': frequent,
    'message:delete': { capacity: 30, refillPerSecond: 5 },
    'audio:played': frequent,
    'typing:start': frequent,
    'typing:stop': frequent,
    'recording:start': frequent,
    'recording:stop': frequent,
    'room:view-start': frequent,
    'room:view-stop': frequent,
    'room:join': { capacity: 120, refillPerSecond: 20 },
    'rooms:get': roomAction,
    'room:create-private': roomAction,
    'room:create-group': { capacity: 20, refillPerSecond: 0.2 },
    'room:join-by-code': roomAction,
    'room:join-by-invite': roomAction,
    'room:reset-invite': roomAction,
    'room:rename': { capacity: 10, refillPerSecond: 0.2 },
    'room:delete': roomAction,
    'group:leave': roomAction,
    'group:remove-member': roomAction,
    'group:promote-admin': roomAction,
    'user:block': roomAction,
    'user:unblock': roomAction,
    'e2e:publish-room-key': keyExchange,
    'e2e:share-room-key': keyExchange,
    'e2e:request-room-key': keyExchange,
    'e2e:get-room-keys': keyExchange,
    'e2e:get-public-keys': keyExchange,
    'e2e:publish-keys': accountAction,
    'e2e:publish-signing-key': accountAction,
    'e2e:get-my-keys': roomAction,
    'user:join': { capacity: 40, refillPerSecond: 1 },
    'user:update-profile': { capacity: 30, refillPerSecond: 3 },
    'user:update-status-text': { capacity: 30, refillPerSecond: 3 },
    'user:update-theme': { capacity: 30, refillPerSecond: 3 },
    'user:update-chat-settings': { capacity: 30, refillPerSecond: 3 },
    'user:visibility': frequent,
    'user:set-locale': roomAction,
    'user:change-password': accountAction,
    'user:regenerate-recovery-file': accountAction,
    'user:logout': accountAction,
    'user:list-sessions': roomAction,
    'user:revoke-session': accountAction,
    'user:set-avatar': { capacity: 10, refillPerSecond: 0.2 },
    'user:clear-avatar': { capacity: 10, refillPerSecond: 0.2 },
    'room:set-avatar': { capacity: 10, refillPerSecond: 0.2 },
    'room:clear-avatar': { capacity: 10, refillPerSecond: 0.2 },
    'room:publish-profile-key': profileKeyAction,
    'room:rewrap-profile-keys': profileKeyAction,
  },
  fallback: { capacity: 60, refillPerSecond: 10 },
};

const FALLBACK_KEY = '*';
const NOTICE_INTERVAL_MS = 1000;

interface BucketState {
  tokens: number;
  updatedAt: number;
}

const USER_BUDGET_MULTIPLIER = 3;
const USER_LIMITER_IDLE_MS = 10 * 60 * 1000;
const USER_LIMITER_SWEEP_INTERVAL_MS = 60 * 1000;

export function scaleBudgets(budgets: SocketEventBudgets, factor: number): SocketEventBudgets {
  const scale = (budget: EventBudget): EventBudget => ({ capacity: budget.capacity * factor, refillPerSecond: budget.refillPerSecond * factor });
  return {
    events: Object.fromEntries(Object.entries(budgets.events).map(([event, budget]) => [event, scale(budget)])),
    fallback: scale(budgets.fallback),
  };
}

export class UserEventLimiters {
  private readonly limiters = new Map<string, { tryConsume: (event: string) => boolean; lastUsedAt: number }>();
  private readonly aggregateBudgets: SocketEventBudgets;
  private lastSweepAt: number;

  constructor(
    budgets: SocketEventBudgets,
    private readonly now: () => number = Date.now,
    multiplier: number = USER_BUDGET_MULTIPLIER,
  ) {
    this.aggregateBudgets = scaleBudgets(budgets, multiplier);
    this.lastSweepAt = now();
  }

  get size(): number {
    return this.limiters.size;
  }

  tryConsume(userId: string, event: string): boolean {
    const current = this.now();
    this.sweepIfDue(current);
    const entry = this.limiters.get(userId) ?? { tryConsume: createEventLimiter(this.aggregateBudgets, this.now), lastUsedAt: current };
    entry.lastUsedAt = current;
    this.limiters.set(userId, entry);
    return entry.tryConsume(event);
  }

  sweep(): void {
    const cutoff = this.now() - USER_LIMITER_IDLE_MS;
    for (const [userId, entry] of this.limiters) {
      if (entry.lastUsedAt <= cutoff) {
        this.limiters.delete(userId);
      }
    }
    this.lastSweepAt = this.now();
  }

  private sweepIfDue(current: number): void {
    if (current - this.lastSweepAt >= USER_LIMITER_SWEEP_INTERVAL_MS) {
      this.sweep();
    }
  }
}

export function createEventLimiter(budgets: SocketEventBudgets, now: () => number = Date.now): (event: string) => boolean {
  const buckets = new Map<string, BucketState>();

  return (event) => {
    const known = Object.hasOwn(budgets.events, event);
    const key = known ? event : FALLBACK_KEY;
    const budget = known ? (budgets.events[event] ?? budgets.fallback) : budgets.fallback;
    const current = now();
    const state = buckets.get(key) ?? { tokens: budget.capacity, updatedAt: current };
    const elapsedSeconds = Math.max(0, current - state.updatedAt) / 1000;
    const tokens = Math.min(budget.capacity, state.tokens + elapsedSeconds * budget.refillPerSecond);

    if (tokens < 1) {
      buckets.set(key, { tokens, updatedAt: current });
      return false;
    }

    buckets.set(key, { tokens: tokens - 1, updatedAt: current });
    return true;
  };
}

function readClientTempId(args: unknown[]): string | undefined {
  const [payload] = args;
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const value = (payload as { clientTempId?: unknown }).clientTempId;
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined;
}

export function applySocketRateLimit(
  socket: AppSocket,
  budgets: SocketEventBudgets = DEFAULT_SOCKET_EVENT_BUDGETS,
  now: () => number = Date.now,
  userLimiters?: UserEventLimiters,
): void {
  const tryConsumeSocket = createEventLimiter(budgets, now);
  const tryConsume = (event: string): boolean => {
    if (!tryConsumeSocket(event)) {
      return false;
    }
    const userId = socket.data.userId;
    return !userLimiters || !userId || userLimiters.tryConsume(userId, event);
  };
  const lastNoticeAt = new Map<string, number>();

  socket.use(([event, ...args], next) => {
    if (tryConsume(event)) {
      next();
      return;
    }

    const noticeKey = Object.hasOwn(budgets.events, event) ? event : FALLBACK_KEY;
    const current = now();
    const previous = lastNoticeAt.get(noticeKey);
    if (previous !== undefined && current - previous < NOTICE_INTERVAL_MS) {
      return;
    }

    lastNoticeAt.set(noticeKey, current);
    logger.warn({ socketId: socket.id, userId: socket.data.userId, event: noticeKey }, 'Socket event rate limit exceeded');
    const clientTempId = readClientTempId(args);
    socket.emit('error', {
      ...errorPayload('rateLimit.socket'),
      ...(noticeKey === FALLBACK_KEY ? {} : { event }),
      ...(clientTempId ? { clientTempId } : {}),
    });
  });
}
