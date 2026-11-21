import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const JOURNAL = path.resolve(import.meta.dirname, '../drizzle/meta/_journal.json');
const META = path.dirname(JOURNAL);

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

  it('chains every snapshot to the one before it', async () => {
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as { entries: JournalEntry[] };
    let previousId = '00000000-0000-0000-0000-000000000000';

    for (const entry of journal.entries) {
      const file = path.join(META, `${String(entry.idx).padStart(4, '0')}_snapshot.json`);
      const snapshot = JSON.parse(await readFile(file, 'utf8')) as { id: string; prevId: string };
      expect(entry.tag.startsWith(String(entry.idx).padStart(4, '0'))).toBe(true);
      expect(snapshot.prevId).toBe(previousId);
      previousId = snapshot.id;
    }
  });
});
