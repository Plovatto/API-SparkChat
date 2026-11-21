import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '@/database/schema.js';

const MIGRATIONS = path.resolve(import.meta.dirname, '../drizzle');
const TAG = '0031_message_hidden';

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
  it('creates message_hidden on an existing database and drops rows when the message goes away', async () => {
    const client = createClient({ url: ':memory:' });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: await migrationsBefore(TAG) });
    const now = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO messages (id, room_id, sender_id, content, type, timestamp, delivered_to, read_by, played_by) VALUES ('m1', 'r1', 'u1', 'oi', 'text', ?, '[]', '[]', '[]')`,
      args: [now],
    });

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect(await rows(client, 'SELECT id, content FROM messages')).toEqual([['m1', 'oi']]);
    expect(await rows(client, `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'message_hidden_message_id_idx'`)).toEqual([['message_hidden_message_id_idx']]);
    await client.execute({ sql: `INSERT INTO message_hidden (user_id, message_id, hidden_at) VALUES ('u2', 'm1', ?)`, args: [now] });
    await expect(client.execute({ sql: `INSERT INTO message_hidden (user_id, message_id, hidden_at) VALUES ('u2', 'm1', ?)`, args: [now] })).rejects.toThrow();
    expect(await rows(client, 'SELECT user_id, message_id FROM message_hidden')).toEqual([['u2', 'm1']]);

    await client.execute('PRAGMA foreign_keys = ON');
    await client.execute(`DELETE FROM messages WHERE id = 'm1'`);
    expect(await rows(client, 'SELECT COUNT(*) FROM message_hidden')).toEqual([[0]]);
    client.close();
  }, 30000);
});
