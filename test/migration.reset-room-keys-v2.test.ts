import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '@/database/schema.js';

const MIGRATIONS = path.resolve(import.meta.dirname, '../drizzle');
const RESET_TAG = '0019_reset_for_room_keys_v2';
const TABLES = ['users', 'sessions', 'rooms', 'room_participants', 'room_bans', 'room_keys', 'messages', 'uploads', 'storage_usage', 'link_previews'];

let workDir: string | null = null;

afterEach(async () => {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

async function migrationsBeforeReset(): Promise<string> {
  workDir = await mkdtemp(path.join(tmpdir(), 'sparkchat-migrations-'));
  await cp(MIGRATIONS, workDir, { recursive: true });
  const journalPath = path.join(workDir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const index = journal.entries.findIndex((entry) => entry.tag === RESET_TAG);
  journal.entries = journal.entries.slice(0, index);
  await writeFile(journalPath, JSON.stringify(journal));
  return workDir;
}

async function populate(client: ReturnType<typeof createClient>): Promise<void> {
  const now = new Date().toISOString();
  const user = (id: string) =>
    client.execute({
      sql: `INSERT INTO users (id, nickname, nickname_normalized, avatar, password_hash, recovery_token_hash, created_at, last_seen, e2e_public_key, e2e_signing_public_key)
            VALUES (?, ?, ?, 0, 'hash', 'recovery', ?, ?, ?, ?)`,
      args: [id, id, id.toLowerCase(), now, now, `${id}-public`, `${id}-signing`],
    });
  await user('spark-ai');
  await user('alice');
  await user('bob');
  await client.batch([
    { sql: `INSERT INTO sessions (id, user_id, token_hash, auth_method, user_agent, created_at, last_used_at) VALUES ('s1', 'alice', 't1', 'password', 'ua', ?, ?)`, args: [now, now] },
    { sql: `INSERT INTO rooms (id, type, name, room_code, created_by, created_at) VALUES ('r1', 'group', 'Amigos', 'CODE1234', 'alice', ?)`, args: [now] },
    { sql: `INSERT INTO rooms (id, type, created_at) VALUES ('r2', 'private', ?)`, args: [now] },
    `INSERT INTO room_participants (room_id, user_id) VALUES ('r1', 'alice'), ('r1', 'bob'), ('r2', 'alice'), ('r2', 'spark-ai')`,
    { sql: `INSERT INTO room_bans (room_id, user_id, banned_at) VALUES ('r1', 'bob', ?)`, args: [now] },
    { sql: `INSERT INTO room_keys (room_id, user_id, sealed_key, created_at) VALUES ('r1', 'alice', 'legacy', ?), ('r2', 'spark-ai', 'legacy', ?)`, args: [now, now] },
    {
      sql: `INSERT INTO messages (id, room_id, sender_id, content, type, timestamp, delivered_to, read_by, played_by) VALUES ('m1', 'r2', 'spark-ai', 'e2e:v1:x', 'text', ?, '[]', '[]', '[]')`,
      args: [now],
    },
    { sql: `INSERT INTO uploads (key, uploader_id, size, created_at) VALUES ('uploads/a', 'alice', 10, ?)`, args: [now] },
    `INSERT INTO storage_usage (id, bytes_used) VALUES ('global', 10)`,
    { sql: `INSERT INTO link_previews (url, status, fetched_at) VALUES ('k', 'ok', ?)`, args: [now] },
  ]);
}

async function count(client: ReturnType<typeof createClient>, table: string): Promise<number> {
  const result = await client.execute(`SELECT count(*) AS total FROM ${table}`);
  return Number(result.rows[0]?.total);
}

describe(`migration ${RESET_TAG}`, () => {
  it('deletes every row except the SparkAI user, keeping its keys, and reshapes room keys', async () => {
    const client = createClient({ url: ':memory:' });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: await migrationsBeforeReset() });
    await populate(client);
    for (const table of TABLES) {
      expect(await count(client, table)).toBeGreaterThan(0);
    }

    await migrate(db, { migrationsFolder: MIGRATIONS });

    for (const table of TABLES.filter((name) => name !== 'users')) {
      expect(await count(client, table)).toBe(0);
    }
    const remaining = await client.execute('SELECT id, e2e_public_key, e2e_signing_public_key FROM users');
    expect(remaining.rows.map((row) => ({ ...row }))).toEqual([{ id: 'spark-ai', e2e_public_key: 'spark-ai-public', e2e_signing_public_key: 'spark-ai-signing' }]);

    const roomColumns = await client.execute('PRAGMA table_info(rooms)');
    expect(roomColumns.rows.map((row) => row.name)).toEqual(expect.arrayContaining(['current_epoch', 'current_key_id', 'rotation_required']));
    const keyColumns = await client.execute('PRAGMA table_info(room_keys)');
    expect(keyColumns.rows.filter((row) => Number(row.pk) > 0).map((row) => row.name)).toEqual(['room_id', 'user_id', 'key_id']);
    expect(keyColumns.rows.map((row) => row.name)).toEqual(expect.arrayContaining(['epoch', 'sender_id']));
    client.close();
  });
});
