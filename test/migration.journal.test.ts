import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const JOURNAL = path.resolve(import.meta.dirname, '../drizzle/meta/_journal.json');

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

describe('drizzle migration journal', () => {
  it('keeps sequential indexes and strictly increasing timestamps', async () => {
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as { entries: JournalEntry[] };

    expect(journal.entries.length).toBeGreaterThan(0);
    journal.entries.forEach((entry, position) => {
      expect(entry.idx).toBe(position);
      if (position > 0) {
        expect(entry.when).toBeGreaterThan((journal.entries[position - 1] as JournalEntry).when);
      }
    });
  });

  it('has a unique tag for every entry', async () => {
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as { entries: JournalEntry[] };

    expect(new Set(journal.entries.map((entry) => entry.tag)).size).toBe(journal.entries.length);
  });
});
