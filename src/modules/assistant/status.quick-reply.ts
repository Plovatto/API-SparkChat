import type { AppServer } from '../../sockets/events.js';
import type { ConfirmDispatcher } from './assistant.confirm.js';
import { STATUS_MAX_LEAD_MS, STATUS_TEXTS, formatUntil } from './status.texts.js';
import { localToUtc } from './zoned-time.js';

export interface StatusConfirmDeps {
  setTemporaryStatus(userId: string, text: string, expiresAt: number): Promise<unknown>;
  broadcastProfile(io: AppServer, userId: string): Promise<void>;
  now?: () => number;
}

export function registerStatusConfirm(dispatcher: ConfirmDispatcher, deps: StatusConfirmDeps): void {
  const now = deps.now ?? Date.now;
  dispatcher.register('status', {
    declined: STATUS_TEXTS.declined,
    confirm: async ({ io, userId, locale }, action) => {
      const until = localToUtc(action.untilLocal, action.timeZone);
      const current = now();
      if (until <= current || until > current + STATUS_MAX_LEAD_MS) {
        return { text: STATUS_TEXTS.passed[locale], card: null };
      }
      const updated = await deps.setTemporaryStatus(userId, action.text, until);
      if (!updated) {
        return { text: STATUS_TEXTS.unavailable[locale], card: null };
      }
      await deps.broadcastProfile(io, userId);
      return { text: STATUS_TEXTS.applied(action.text, formatUntil(until, current, action.timeZone, locale), locale), card: null };
    },
  });
}
