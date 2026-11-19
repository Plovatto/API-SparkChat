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

export const DEFAULT_SOCKET_EVENT_BUDGETS: SocketEventBudgets = {
  events: {
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
  },
  fallback: { capacity: 60, refillPerSecond: 10 },
};

const FALLBACK_KEY = '*';
const NOTICE_INTERVAL_MS = 1000;

interface BucketState {
  tokens: number;
  updatedAt: number;
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
): void {
  const tryConsume = createEventLimiter(budgets, now);
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
