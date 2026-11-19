import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '@/database/schema.js';

const MIGRATIONS = path.resolve(import.meta.dirname, '../drizzle');
const DELETE_TAG = '0022_delete_group_rooms_without_roster';

let workDir: string | null = null;

afterEach(async () => {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

async function migrationsBeforeDelete(): Promise<string> {
  workDir = await mkdtemp(path.join(tmpdir(), 'sparkchat-migrations-'));
  await cp(MIGRATIONS, workDir, { recursive: true });
  const journalPath = path.join(workDir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const index = journal.entries.findIndex((entry) => entry.tag === DELETE_TAG);
  expect(index).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, index);
  await writeFile(journalPath, JSON.stringify(journal));
  return workDir;
}

async function populate(client: ReturnType<typeof createClient>): Promise<void> {
  const now = new Date().toISOString();
  const user = (id: string) =>
    client.execute({
      sql: `INSERT INTO users (id, nickname, nickname_normalized, avatar, password_hash, recovery_token_hash, created_at, last_seen)
            VALUES (?, ?, ?, 0, 'hash', 'recovery', ?, ?)`,
      args: [id, id, id.toLowerCase(), now, now],
    });
  await user('spark-ai');
  await user('alice');
  await user('bob');
  const message = (id: string, roomId: string) => ({
    sql: `INSERT INTO messages (id, room_id, sender_id, content, type, timestamp, delivered_to, read_by, played_by) VALUES (?, ?, 'alice', 'x', 'text', ?, '[]', '[]', '[]')`,
    args: [id, roomId, now],
  });
  const key = (roomId: string, userId: string) => ({
    sql: `INSERT INTO room_keys (room_id, user_id, key_id, epoch, sealed_key, sender_id, created_at) VALUES (?, ?, 'K1', 1, 'sealed', 'alice', ?)`,
    args: [roomId, userId, now],
  });
  await client.batch([
    { sql: `INSERT INTO rooms (id, type, name, room_code, created_by, created_at, current_epoch, current_key_id) VALUES ('g1', 'group', 'Amigos', 'CODE123456', 'alice', ?, 1, 'K1')`, args: [now] },
    { sql: `INSERT INTO rooms (id, type, name, created_by, created_at) VALUES ('g2', 'group', 'Vazio', 'bob', ?)`, args: [now] },
    { sql: `INSERT INTO rooms (id, type, created_at, current_epoch, current_key_id) VALUES ('p1', 'private', ?, 1, 'K1')`, args: [now] },
    `INSERT INTO room_participants (room_id, user_id) VALUES ('g1', 'alice'), ('g1', 'bob'), ('g2', 'bob'), ('p1', 'alice'), ('p1', 'spark-ai')`,
    { sql: `INSERT INTO room_bans (room_id, user_id, banned_at) VALUES ('g1', 'bob', ?)`, args: [now] },
    key('g1', 'alice'),
    key('p1', 'alice'),
    key('p1', 'spark-ai'),
    message('gm1', 'g1'),
    message('gm2', 'g1'),
    message('pm1', 'p1'),
    { sql: `INSERT INTO uploads (key, uploader_id, size, created_at, message_id) VALUES ('uploads/g', 'alice', 30, ?, 'gm1')`, args: [now] },
    { sql: `INSERT INTO uploads (key, uploader_id, size, created_at, message_id) VALUES ('uploads/p', 'alice', 12, ?, 'pm1')`, args: [now] },
    { sql: `INSERT INTO uploads (key, uploader_id, size, created_at) VALUES ('uploads/pending', 'bob', 5, ?)`, args: [now] },
    `INSERT INTO storage_usage (id, bytes_used) VALUES ('global', 47)`,
  ]);
}

async function ids(client: ReturnType<typeof createClient>, sql: string): Promise<string[]> {
  const result = await client.execute(sql);
  return result.rows.map((row) => String(row[0] as string | number));
}

describe(`migration ${DELETE_TAG}`, () => {
  it('deletes every group room with its keys, members, bans, messages and their uploads, keeping private rooms and users', async () => {
    const client = createClient({ url: ':memory:' });
    await client.execute('PRAGMA foreign_keys = ON');
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: await migrationsBeforeDelete() });
    await populate(client);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect(await ids(client, 'SELECT id FROM rooms ORDER BY id')).toEqual(['p1']);
    expect(await ids(client, "SELECT room_id || ':' || user_id FROM room_participants ORDER BY user_id")).toEqual(['p1:alice', 'p1:spark-ai']);
    expect(await ids(client, "SELECT room_id || ':' || user_id FROM room_keys ORDER BY user_id")).toEqual(['p1:alice', 'p1:spark-ai']);
    expect(await ids(client, 'SELECT room_id FROM room_bans')).toEqual([]);
    expect(await ids(client, 'SELECT id FROM messages')).toEqual(['pm1']);
    expect(await ids(client, 'SELECT key FROM uploads ORDER BY key')).toEqual(['uploads/p', 'uploads/pending']);
    expect(await ids(client, "SELECT bytes_used FROM storage_usage WHERE id = 'global'")).toEqual(['17']);
    expect(await ids(client, 'SELECT id FROM users ORDER BY id')).toEqual(['alice', 'bob', 'spark-ai']);
    client.close();
  });
});
