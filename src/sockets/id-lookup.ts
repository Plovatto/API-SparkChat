import { errorPayload, type ErrorPayload } from '../lib/app-error.js';

export const E2E_LOOKUP_MAX_ITEMS = 200;

export function exceedsLookupLimit(payload: unknown, key: string, maxItems = E2E_LOOKUP_MAX_ITEMS): boolean {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }

  const items = (payload as Record<string, unknown>)[key];
  return Array.isArray(items) && items.length > maxItems;
}

export function lookupTooLargePayload(event: string, maxItems = E2E_LOOKUP_MAX_ITEMS): ErrorPayload & { event: string } {
  return { ...errorPayload('e2e.lookupTooLarge', { maxItems }), event };
}
