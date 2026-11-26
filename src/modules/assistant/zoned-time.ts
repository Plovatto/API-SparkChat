import type { Recurrence } from './assistant.card.js';

export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export interface LocalParts extends LocalDateTime {
  weekday: number;
}

const MINUTE = 60000;
const DAY = 86400000;
const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

export function parseLocalDateTime(local: string): LocalDateTime | null {
  const match = LOCAL_PATTERN.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (hour > 23 || minute > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day, hour, minute };
}

export function utcToLocalParts(ms: number, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  const hour = pick('hour') % 24;
  const minute = pick('minute');
  return { year, month, day, hour, minute, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

export function nowLocalString(ms: number, timeZone: string): string {
  const p = utcToLocalParts(ms, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

function offsetAt(ms: number, timeZone: string): number {
  const p = utcToLocalParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / MINUTE) * MINUTE;
}

function wallToUtc(wall: LocalDateTime, timeZone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const offsets = [...new Set([offsetAt(asUtc - DAY, timeZone), offsetAt(asUtc + DAY, timeZone)])];
  const valid = offsets
    .map((offset) => asUtc - offset)
    .filter((candidate) => offsetAt(candidate, timeZone) === asUtc - candidate)
    .sort((a, b) => a - b);
  if (valid.length > 0) return valid[0] as number;

  const before = offsetAt(asUtc - DAY, timeZone);
  let low = Math.floor((asUtc - before - DAY) / MINUTE);
  let high = Math.floor((asUtc - before + DAY) / MINUTE);
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (offsetAt(mid * MINUTE, timeZone) === before) low = mid + 1;
    else high = mid;
  }
  return low * MINUTE;
}

export function localToUtc(local: string, timeZone: string): number {
  const wall = parseLocalDateTime(local);
  if (!wall) throw new Error(`Invalid local date-time: ${local}`);
  return wallToUtc(wall, timeZone);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(wall: LocalDateTime, days: number): LocalDateTime {
  const moved = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return { ...wall, year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

function nextWall(previous: LocalParts, recurrence: Recurrence, anchorDay: number): LocalDateTime {
  const interval = Math.max(1, Math.floor(recurrence.interval ?? 1));
  if (recurrence.freq === 'daily') return addDays(previous, interval);

  if (recurrence.freq === 'weekly') {
    const weekdays = recurrence.weekdays && recurrence.weekdays.length > 0 ? recurrence.weekdays : [previous.weekday];
    for (let offset = 1; offset <= 7 * interval + 7; offset += 1) {
      const weekday = (previous.weekday + offset) % 7;
      const weekIndex = Math.floor((previous.weekday + offset) / 7);
      if (weekdays.includes(weekday) && weekIndex % interval === 0) return addDays(previous, offset);
    }
    return addDays(previous, 7 * interval);
  }

  const monthIndex = previous.year * 12 + (previous.month - 1) + interval;
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  return { year, month, day: Math.min(anchorDay, daysInMonth(year, month)), hour: previous.hour, minute: previous.minute };
}

export function nextOccurrence(previousFireAt: number, recurrence: Recurrence, timeZone: string, anchorDay?: number): number {
  const previous = utcToLocalParts(previousFireAt, timeZone);
  const anchor = anchorDay ?? previous.day;
  let current: LocalParts = previous;
  let result = previousFireAt;
  for (let guard = 0; guard < 8 && result <= previousFireAt; guard += 1) {
    const wall = nextWall(current, recurrence, anchor);
    result = wallToUtc(wall, timeZone);
    current = { ...wall, weekday: new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay() };
  }
  return result;
}

export function formatForUser(ms: number, timeZone: string, locale: string): string {
  const tag = locale === 'pt' ? 'pt-BR' : locale === 'en' ? 'en-US' : locale;
  return new Intl.DateTimeFormat(tag, { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(ms));
}
