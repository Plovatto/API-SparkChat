import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '@/database/schema.js';

const MIGRATIONS = path.resolve(import.meta.dirname, '../drizzle');
const TAG = '0024_calls';

let workDir: string | null = null;

afterEach(async () => {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

async function migrationsBefore(tag: string): Promise<string> {
  workDir = await mkdtemp(path.join(tmpdir(), 'sparkchat-migrations-'));
  await cp(MIGRATIONS, workDir, { recursive: true });
  const journalPath = path.join(workDir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  expect(index).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, index);
  await writeFile(journalPath, JSON.stringify(journal));
  return workDir;
}

async function rows(client: ReturnType<typeof createClient>, sql: string): Promise<unknown[][]> {
  const result = await client.execute(sql);
  return result.rows.map((row) => Array.from(row));
}

describe(`migration ${TAG}`, () => {
  it('adds the calls tables without touching existing data', async () => {
    const client = createClient({ url: ':memory:' });
    await client.execute('PRAGMA foreign_keys = ON');
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: await migrationsBefore(TAG) });
    const now = new Date().toISOString();
    await client.batch([
      { sql: `INSERT INTO rooms (id, type, created_at) VALUES ('r1', 'private', ?)`, args: [now] },
      {
        sql: `INSERT INTO messages (id, room_id, sender_id, content, type, timestamp, delivered_to, read_by, played_by) VALUES ('m1', 'r1', 'u1', 'oi', 'text', ?, '[]', '[]', '[]')`,
        args: [now],
      },
    ]);
    expect(await rows(client, `SELECT name FROM sqlite_master WHERE name IN ('calls', 'call_usage')`)).toEqual([]);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect(await rows(client, 'SELECT id, content FROM messages')).toEqual([['m1', 'oi']]);
    expect(await rows(client, `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('calls', 'call_usage') ORDER BY name`)).toEqual([
      ['call_usage'],
      ['calls'],
    ]);

    await client.execute({
      sql: `INSERT INTO calls (id, room_id, caller_id, callee_id, kind, state, created_at) VALUES ('c1', 'r1', 'u1', 'u2', 'voice', 'ringing', ?)`,
      args: [now],
    });
    expect(await rows(client, 'SELECT id, relay_used, turn_username, turn_revoked_at FROM calls')).toEqual([['c1', 0, null, null]]);
    client.close();
  }, 30000);
});
