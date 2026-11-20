import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '@/database/migrate.js';
import * as schema from '@/database/schema.js';
import { setupTransparency, TransparencyLog, TransparencyRepository, TransparencyService, TreeHeadSigner } from '@/modules/transparency/index.js';
import type { LeafRow, NodeRow } from '@/modules/transparency/transparency.repository.js';

async function migratedDb() {
  const db = drizzle(createClient({ url: ':memory:' }), { schema });
  await runMigrations(db);
  return db;
}

const directory = { findKeys: () => Promise.resolve(null), listKeyedUsers: () => Promise.resolve([]) };

describe('appending keys', () => {
  it('skips a key that cannot be encoded and still logs the others', async () => {
    const log = new TransparencyLog(new TransparencyRepository(await migratedDb()), TreeHeadSigner.ephemeral());
    const poisoned = { userId: 'poisoned', publicKey: 'é'.repeat(200), signingPublicKey: null };
    const empty = { userId: 'empty', publicKey: '', signingPublicKey: null };
    const good = { userId: 'good', publicKey: 'a'.repeat(43), signingPublicKey: null };

    expect(await log.recordMany([poisoned, empty, good])).toBe(1);
    expect(await log.size()).toBe(1);
    expect(await log.record(poisoned)).toBe(false);
  });

  it('lets the backfill finish when one stored key is poisoned', async () => {
    const log = new TransparencyLog(new TransparencyRepository(await migratedDb()), TreeHeadSigner.ephemeral());
    const rows = [
      { id: 'a', publicKey: 'é'.repeat(200), signingPublicKey: null },
      { id: 'b', publicKey: 'b'.repeat(43), signingPublicKey: null },
    ];
    const service = new TransparencyService(log, {
      findKeys: () => Promise.resolve(null),
      listKeyedUsers: (after) => Promise.resolve(after === '' ? rows : []),
    });
    expect(await service.backfill()).toBe(1);
    expect(await service.backfill()).toBe(0);
    expect(await log.size()).toBe(1);
  });

  it('retries only unique constraint conflicts', async () => {
    const real = new TransparencyRepository(await migratedDb());
    let calls = 0;
    const failing = Object.create(real) as TransparencyRepository;
    failing.append = (leaves: LeafRow[], nodes: NodeRow[]) => {
      calls += 1;
      if (calls <= 2) {
        return Promise.reject(Object.assign(new Error('UNIQUE constraint failed: transparency_leaves.position'), { code: 'SQLITE_CONSTRAINT' }));
      }
      return real.append(leaves, nodes);
    };
    const log = new TransparencyLog(failing, TreeHeadSigner.ephemeral());
    expect(await log.record({ userId: 'u', publicKey: 'k'.repeat(43), signingPublicKey: null })).toBe(true);
    expect(calls).toBe(3);

    let other = 0;
    const broken = Object.create(real) as TransparencyRepository;
    broken.append = () => {
      other += 1;
      return Promise.reject(new Error('disk I/O error'));
    };
    await expect(new TransparencyLog(broken, TreeHeadSigner.ephemeral()).record({ userId: 'v', publicKey: 'k'.repeat(43), signingPublicKey: null })).rejects.toThrow(/disk/);
    expect(other).toBe(1);
  });

  it('signs only the current size with the current time', async () => {
    let now = 1000;
    const log = new TransparencyLog(new TransparencyRepository(await migratedDb()), TreeHeadSigner.ephemeral(), () => now);
    await log.record({ userId: 'a', publicKey: 'a'.repeat(43), signingPublicKey: null });
    await log.record({ userId: 'b', publicKey: 'b'.repeat(43), signingPublicKey: null });
    now = 5000;
    const head = await log.head();
    expect(head.size).toBe(2);
    expect(head.issuedAt).toBe(5000);
  });
});

describe('server boot', () => {
  const env = { nodeEnv: 'test', KEY_TRANSPARENCY_ENABLED: true };

  it('disables the feature instead of crashing when the tables are missing', async () => {
    const db = drizzle(createClient({ url: ':memory:' }), { schema });
    let registered = false;
    expect(await setupTransparency(env, db, directory, () => (registered = true))).toBeNull();
    expect(registered).toBe(false);
  });

  it('stays off without touching the database when the flag is off', async () => {
    const db = drizzle(createClient({ url: ':memory:' }), { schema });
    expect(await setupTransparency({ ...env, KEY_TRANSPARENCY_ENABLED: false }, db, directory, () => undefined)).toBeNull();
  });

  it('starts with migrated tables and registers the key listener', async () => {
    let registered = false;
    const setup = await setupTransparency(env, await migratedDb(), directory, () => (registered = true));
    expect(setup?.service.getConfig().enabled).toBe(true);
    expect(registered).toBe(true);
    expect(setup?.witness.enabled).toBe(false);
  });

  it('refuses to start in a deployed mode without a configured key', async () => {
    await expect(setupTransparency({ ...env, nodeEnv: undefined }, await migratedDb(), directory, () => undefined)).rejects.toThrow(/KT_LOG_SIGNING_KEY/);
  });
});

describe('migration journal', () => {
  it('keeps the key transparency migration after every earlier one by index and by timestamp', async () => {
    const journal = JSON.parse(await readFile(path.resolve(import.meta.dirname, '../drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const ours = journal.entries.find((entry) => entry.tag === '0028_key_transparency');
    expect(ours).toBeDefined();
    for (const entry of journal.entries) {
      if (entry.idx < (ours?.idx ?? 0)) {
        expect(entry.when).toBeLessThan(ours?.when ?? 0);
      }
    }
    const whens = journal.entries.map((entry) => entry.when);
    expect(whens).toEqual([...whens].sort((a, b) => a - b));
    expect(new Set(whens).size).toBe(whens.length);
  });
});
