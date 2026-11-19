import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '@/database/schema.js';

const MIGRATIONS = path.resolve(import.meta.dirname, '../drizzle');
const TAG = '0023_encrypted_group_name_and_rosters';

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
  it('clears every plaintext group name and keeps the current roster as the roster of its generation', async () => {
    const client = createClient({ url: ':memory:' });
    await client.execute('PRAGMA foreign_keys = ON');
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: await migrationsBefore(TAG) });
    const now = new Date().toISOString();
    await client.batch([
      { sql: `INSERT INTO rooms (id, type, name, created_at, current_epoch, current_key_id, encrypted_roster, roster_key_id) VALUES ('g1', 'group', 'Amigos', ?, 2, 'K2', 'roster-k2', 'K2')`, args: [now] },
      { sql: `INSERT INTO rooms (id, type, name, created_at) VALUES ('g2', 'group', 'Sem chave', ?)`, args: [now] },
      { sql: `INSERT INTO rooms (id, type, name, created_at, current_epoch, current_key_id) VALUES ('p1', 'private', 'legado', ?, 1, 'K1')`, args: [now] },
    ]);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect(await rows(client, 'SELECT id, name, encrypted_name, name_key_id FROM rooms ORDER BY id')).toEqual([
      ['g1', null, null, null],
      ['g2', null, null, null],
      ['p1', 'legado', null, null],
    ]);
    expect(await rows(client, 'SELECT room_id, key_id, encrypted_roster FROM room_rosters')).toEqual([['g1', 'K2', 'roster-k2']]);
    client.close();
  });
});
