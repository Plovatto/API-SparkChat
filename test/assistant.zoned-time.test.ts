import { describe, expect, it } from 'vitest';
import {
  formatForUser,
  localToUtc,
  nextOccurrence,
  anchorFromLocal,
  nowLocalString,
  parseLocalDateTime,
  utcToLocalParts,
} from '@/modules/assistant/zoned-time.js';

const NY = 'America/New_York';
const SP = 'America/Sao_Paulo';

describe('parseLocalDateTime', () => {
  it('parses valid values', () => {
    expect(parseLocalDateTime('2026-11-27T09:05')).toEqual({ year: 2026, month: 11, day: 27, hour: 9, minute: 5 });
  });

  it('rejects invalid values', () => {
    for (const value of ['2026-02-30T09:00', '2026-13-01T09:00', '2026-11-27T24:00', '2026-11-27T09:60', '2026-11-27', '2026-11-27T09:00:00Z', 'x']) {
      expect(parseLocalDateTime(value)).toBeNull();
    }
  });
});

describe('anchorFromLocal', () => {
  it('extracts day and wall time', () => {
    expect(anchorFromLocal('2027-01-31T08:15')).toEqual({ day: 31, hour: 8, minute: 15 });
    expect(anchorFromLocal('2027-02-30T08:15')).toBeNull();
  });
});

describe('localToUtc', () => {
  it('converts Sao Paulo (no DST)', () => {
    expect(localToUtc('2026-11-27T09:00', SP)).toBe(Date.UTC(2026, 10, 27, 12, 0));
    expect(localToUtc('2026-01-15T09:00', SP)).toBe(Date.UTC(2026, 0, 15, 12, 0));
  });

  it('converts New York in both offsets', () => {
    expect(localToUtc('2027-01-15T09:00', NY)).toBe(Date.UTC(2027, 0, 15, 14, 0));
    expect(localToUtc('2027-07-15T09:00', NY)).toBe(Date.UTC(2027, 6, 15, 13, 0));
  });

  it('moves a nonexistent spring-forward time to the first valid instant', () => {
    const ms = localToUtc('2027-03-14T02:30', NY);
    expect(ms).toBe(Date.UTC(2027, 2, 14, 7, 0));
    expect(nowLocalString(ms, NY)).toBe('2027-03-14T03:00');
  });

  it('picks the first occurrence of an ambiguous fall-back time', () => {
    expect(localToUtc('2026-11-01T01:30', NY)).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });

  it('throws on an invalid string', () => {
    expect(() => localToUtc('2026-02-30T09:00', NY)).toThrow();
  });
});

describe('utcToLocalParts and nowLocalString', () => {
  it('returns local parts with weekday', () => {
    expect(utcToLocalParts(Date.UTC(2026, 10, 27, 12, 0), SP)).toEqual({ year: 2026, month: 11, day: 27, hour: 9, minute: 0, weekday: 5 });
  });

  it('formats the local string', () => {
    expect(nowLocalString(Date.UTC(2026, 10, 27, 2, 5), SP)).toBe('2026-11-26T23:05');
  });
});

describe('nextOccurrence', () => {
  it('daily keeps local hour across spring-forward', () => {
    const first = localToUtc('2027-03-13T08:00', NY);
    const next = nextOccurrence(first, { freq: 'daily' }, NY);
    expect(next).toBe(localToUtc('2027-03-14T08:00', NY));
    expect(next - first).toBe(23 * 3600000);
  });

  it('daily keeps local hour across fall-back', () => {
    const first = localToUtc('2026-10-31T08:00', NY);
    const next = nextOccurrence(first, { freq: 'daily' }, NY);
    expect(next).toBe(localToUtc('2026-11-01T08:00', NY));
    expect(next - first).toBe(25 * 3600000);
  });

  it('daily returns to the original wall time after a spring-forward gap', () => {
    const anchor = anchorFromLocal('2027-03-13T02:30')!;
    const gap = localToUtc('2027-03-14T02:30', NY);
    expect(nowLocalString(gap, NY)).toBe('2027-03-14T03:00');
    const next = nextOccurrence(gap, { freq: 'daily' }, NY, anchor);
    expect(nowLocalString(next, NY)).toBe('2027-03-15T02:30');
    expect(nowLocalString(nextOccurrence(gap, { freq: 'daily' }, NY), NY)).toBe('2027-03-15T03:00');
  });

  it('daily respects interval', () => {
    const first = localToUtc('2026-11-27T08:00', SP);
    expect(nextOccurrence(first, { freq: 'daily', interval: 3 }, SP)).toBe(localToUtc('2026-11-30T08:00', SP));
  });

  it('weekly with several weekdays picks the next matching day', () => {
    const monday = localToUtc('2026-11-23T08:00', SP);
    const wednesday = nextOccurrence(monday, { freq: 'weekly', weekdays: [1, 3] }, SP);
    expect(wednesday).toBe(localToUtc('2026-11-25T08:00', SP));
    expect(nextOccurrence(wednesday, { freq: 'weekly', weekdays: [1, 3] }, SP)).toBe(localToUtc('2026-11-30T08:00', SP));
  });

  it('weekly defaults to the same weekday and respects interval', () => {
    const monday = localToUtc('2026-11-23T08:00', SP);
    expect(nextOccurrence(monday, { freq: 'weekly' }, SP)).toBe(localToUtc('2026-11-30T08:00', SP));
    expect(nextOccurrence(monday, { freq: 'weekly', interval: 2 }, SP)).toBe(localToUtc('2026-12-07T08:00', SP));
    expect(nextOccurrence(monday, { freq: 'weekly', weekdays: [1, 3], interval: 2 }, SP)).toBe(localToUtc('2026-11-25T08:00', SP));
    const wednesday = localToUtc('2026-11-25T08:00', SP);
    expect(nextOccurrence(wednesday, { freq: 'weekly', weekdays: [1, 3], interval: 2 }, SP)).toBe(localToUtc('2026-12-07T08:00', SP));
  });

  it('monthly on day 31 clamps to the last day and returns to 31', () => {
    const jan = localToUtc('2027-01-31T08:00', SP);
    const feb = nextOccurrence(jan, { freq: 'monthly' }, SP);
    expect(feb).toBe(localToUtc('2027-02-28T08:00', SP));
    const mar = nextOccurrence(feb, { freq: 'monthly' }, SP, anchorFromLocal('2027-01-31T08:00')!);
    expect(mar).toBe(localToUtc('2027-03-31T08:00', SP));
    const apr = nextOccurrence(mar, { freq: 'monthly' }, SP, anchorFromLocal('2027-01-31T08:00')!);
    expect(apr).toBe(localToUtc('2027-04-30T08:00', SP));
  });

  it('monthly in a leap year gives February 29 and respects interval', () => {
    const jan = localToUtc('2028-01-31T08:00', SP);
    expect(nextOccurrence(jan, { freq: 'monthly' }, SP)).toBe(localToUtc('2028-02-29T08:00', SP));
    expect(nextOccurrence(jan, { freq: 'monthly', interval: 2 }, SP)).toBe(localToUtc('2028-03-31T08:00', SP));
  });

  it('monthly rolls over the year', () => {
    const dec = localToUtc('2026-12-15T08:00', SP);
    expect(nextOccurrence(dec, { freq: 'monthly' }, SP)).toBe(localToUtc('2027-01-15T08:00', SP));
  });

  it('always returns a time strictly after the previous fire', () => {
    const recurrences = [{ freq: 'daily' as const }, { freq: 'weekly' as const, weekdays: [0, 6] }, { freq: 'monthly' as const }];
    for (const tz of [NY, SP]) {
      for (const recurrence of recurrences) {
        let at = localToUtc('2027-03-12T02:30', tz);
        for (let i = 0; i < 40; i += 1) {
          const next = nextOccurrence(at, recurrence, tz);
          expect(next).toBeGreaterThan(at);
          at = next;
        }
      }
    }
  });
});

describe('formatForUser', () => {
  it('formats in pt and en', () => {
    const ms = Date.UTC(2026, 10, 27, 12, 0);
    expect(formatForUser(ms, SP, 'pt')).toContain('27');
    expect(formatForUser(ms, SP, 'pt')).toContain('09:00');
    expect(formatForUser(ms, SP, 'en')).toMatch(/November 27, 2026/);
  });
});
