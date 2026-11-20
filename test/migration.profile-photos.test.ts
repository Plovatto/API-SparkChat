import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '@/database/schema.js';

const MIGRATIONS = path.resolve(import.meta.dirname, '../drizzle');
const TAG = '0027_profile_photos';

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
  it('adds the profile photo columns to an existing database without touching its data', async () => {
    const client = createClient({ url: ':memory:' });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: await migrationsBefore(TAG) });
    const now = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO users (id, nickname, nickname_normalized, avatar, password_hash, recovery_token_hash, created_at, last_seen) VALUES ('u1', 'Alice', 'alice', 5, 'h', 'r', ?, ?)`,
      args: [now, now],
    });
    await client.execute({ sql: `INSERT INTO rooms (id, type, created_at, encrypted_name, name_key_id) VALUES ('g1', 'group', ?, 'name', 'k1')`, args: [now] });
    await client.execute({ sql: `INSERT INTO room_participants (room_id, user_id, joined_at) VALUES ('g1', 'u1', ?)`, args: [now] });
    await client.execute({ sql: `INSERT INTO uploads (key, uploader_id, size, created_at) VALUES ('uploads/images/a.bin', 'u1', 10, ?)`, args: [now] });

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect(await rows(client, 'SELECT id, avatar, encrypted_avatar, avatar_upload_key, profile_key_version FROM users')).toEqual([['u1', 5, null, null, 1]]);
    expect(await rows(client, 'SELECT id, encrypted_name, encrypted_avatar, avatar_key_id, avatar_upload_key FROM rooms')).toEqual([['g1', 'name', null, null, null]]);
    expect(await rows(client, 'SELECT user_id, profile_key_envelope, profile_key_key_id FROM room_participants')).toEqual([['u1', null, null]]);
    expect(await rows(client, 'SELECT key, message_id, avatar_owner FROM uploads')).toEqual([['uploads/images/a.bin', null, null]]);
    expect(await rows(client, `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uploads_avatar_owner_idx'`)).toEqual([['uploads_avatar_owner_idx']]);
    client.close();
  }, 30000);
});
