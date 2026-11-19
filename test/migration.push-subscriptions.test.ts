import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '@/database/schema.js';

const MIGRATIONS = path.resolve(import.meta.dirname, '../drizzle');
const TAG = '0025_push_subscriptions';

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
  it('adds push_subscriptions without touching existing data and cascades with the user', async () => {
    const client = createClient({ url: ':memory:' });
    await client.execute('PRAGMA foreign_keys = ON');
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: await migrationsBefore(TAG) });
    const now = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO users (id, nickname, nickname_normalized, avatar, password_hash, recovery_token_hash, created_at, last_seen) VALUES ('u1', 'Alice', 'alice', 0, 'h', 'r', ?, ?)`,
      args: [now, now],
    });
    expect(await rows(client, `SELECT name FROM sqlite_master WHERE name = 'push_subscriptions'`)).toEqual([]);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect(await rows(client, 'SELECT id, nickname FROM users')).toEqual([['u1', 'Alice']]);
    const insert = `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, last_used_at) VALUES (?, 'u1', 'https://fcm.googleapis.com/x', 'k', 'a', ?, ?)`;
    await client.execute({ sql: insert, args: ['s1', now, now] });
    await expect(client.execute({ sql: insert, args: ['s2', now, now] })).rejects.toThrow(/UNIQUE/);
    await client.execute(`DELETE FROM users WHERE id = 'u1'`);
    expect(await rows(client, 'SELECT id FROM push_subscriptions')).toEqual([]);
    client.close();
  }, 30000);
});
