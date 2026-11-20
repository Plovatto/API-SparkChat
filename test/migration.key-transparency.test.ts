import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '@/database/schema.js';
import { TransparencyLog, TransparencyRepository, TreeHeadSigner } from '@/modules/transparency/index.js';

const MIGRATIONS = path.resolve(import.meta.dirname, '../drizzle');
const TAG = '0029_key_transparency';

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

async function tableNames(client: ReturnType<typeof createClient>): Promise<string[]> {
  const result = await client.execute(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'transparency_%' ORDER BY name`);
  return result.rows.map((row) => row[0] as string);
}

const EXPECTED_TABLES = ['transparency_leaves', 'transparency_meta', 'transparency_nodes'];

describe(`migration ${TAG}`, () => {
  it('creates the log tables on a fresh database', async () => {
    const client = createClient({ url: ':memory:' });
    await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS });
    expect(await tableNames(client)).toEqual(EXPECTED_TABLES);
    client.close();
  }, 30000);

  it('adds the log tables to an existing database without touching its data and keeps the log usable', async () => {
    const client = createClient({ url: ':memory:' });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: await migrationsBefore(TAG) });
    const now = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO users (id, nickname, nickname_normalized, avatar, password_hash, recovery_token_hash, created_at, last_seen, e2e_public_key) VALUES ('u1', 'Alice', 'alice', 5, 'h', 'r', ?, ?, 'pub')`,
      args: [now, now],
    });
    expect(await tableNames(client)).toEqual([]);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect(await tableNames(client)).toEqual(EXPECTED_TABLES);
    const users = await client.execute('SELECT id, nickname, e2e_public_key FROM users');
    expect(users.rows.map((row) => Array.from(row))).toEqual([['u1', 'Alice', 'pub']]);

    const log = new TransparencyLog(new TransparencyRepository(db), TreeHeadSigner.ephemeral());
    expect(await log.record({ userId: 'u1', publicKey: 'pub', signingPublicKey: null })).toBe(true);
    expect((await log.head()).size).toBe(1);
    client.close();
  }, 30000);

  it('is idempotent when migrations run twice', async () => {
    const client = createClient({ url: ':memory:' });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect(await tableNames(client)).toHaveLength(3);
    client.close();
  }, 30000);

  it('fails cleanly on a database that already holds the tables of the earlier numbering and recovers once they are dropped', async () => {
    const client = createClient({ url: ':memory:' });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: await migrationsBefore('0028_group_integrity_rotation') });
    await client.execute('CREATE TABLE `transparency_leaves` (`position` integer PRIMARY KEY NOT NULL)');
    await client.execute('CREATE TABLE `transparency_nodes` (`level` integer NOT NULL)');
    await client.execute('CREATE TABLE `transparency_meta` (`key` text PRIMARY KEY NOT NULL)');

    await expect(migrate(db, { migrationsFolder: MIGRATIONS })).rejects.toThrow();

    for (const table of EXPECTED_TABLES) {
      await client.execute(`DROP TABLE ${table}`);
    }
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect(await tableNames(client)).toEqual(EXPECTED_TABLES);
    const log = new TransparencyLog(new TransparencyRepository(db), TreeHeadSigner.ephemeral());
    expect(await log.record({ userId: 'u', publicKey: 'k'.repeat(43), signingPublicKey: null })).toBe(true);
    client.close();
  }, 30000);
});
