import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '@/database/schema.js';

const MIGRATIONS = path.resolve(import.meta.dirname, '../drizzle');
const TAG = '0026_upload_expiry';

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
  it('adds a nullable expires_at column and its index to uploads without touching existing rows', async () => {
    const client = createClient({ url: ':memory:' });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: await migrationsBefore(TAG) });
    const now = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO uploads (key, uploader_id, size, created_at, message_id) VALUES ('uploads/images/a.bin', 'u1', 10, ?, 'm1')`,
      args: [now],
    });

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect(await rows(client, 'SELECT key, size, message_id, expires_at FROM uploads')).toEqual([['uploads/images/a.bin', 10, 'm1', null]]);
    expect(await rows(client, `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uploads_expires_at_idx'`)).toEqual([
      ['uploads_expires_at_idx'],
    ]);
    client.close();
  }, 30000);
});
