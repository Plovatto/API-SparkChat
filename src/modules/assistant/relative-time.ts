import { z } from 'zod';
import type { AssistantContext } from './assistant.toolbox.js';
import { nowLocalString, parseLocalDateTime } from './zoned-time.js';

export const RELATIVE_MINUTES_MAX = 525600;
const MINUTE_MS = 60_000;

export const relativeMinutesSchema = z.number().int().min(1).max(RELATIVE_MINUTES_MAX).optional();

export function relativeMinutesParameter(description: string) {
  return { type: 'integer', minimum: 1, maximum: RELATIVE_MINUTES_MAX, description };
}

export type ResolvedTime = { local: string } | { error: 'need_time' | 'invalid_time' };

export function resolveLocalTime(local: string | undefined, minutes: number | undefined, ctx: Pick<AssistantContext, 'now' | 'timeZone'>): ResolvedTime {
  if (local !== undefined && minutes !== undefined) {
    return { error: 'invalid_time' };
  }
  if (minutes !== undefined) {
    const target = Math.ceil((ctx.now + minutes * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
    return { local: nowLocalString(target, ctx.timeZone) };
  }
  if (!local) {
    return { error: 'need_time' };
  }
  return parseLocalDateTime(local) ? { local } : { error: 'invalid_time' };
}
