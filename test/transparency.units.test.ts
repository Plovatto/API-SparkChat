import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { runMigrations } from '@/database/migrate.js';
import * as schema from '@/database/schema.js';
import { encodeLeaf, leafHashOf, leafIdOf } from '@/modules/transparency/transparency.leaf.js';
import { MemoryNodeSource, rootHash, verifyConsistency, verifyInclusion } from '@/modules/transparency/transparency.merkle.js';
import { generateSigningSeed, headSigningBytes, parseSigningSeed, TreeHeadSigner, verifySignedTreeHead } from '@/modules/transparency/transparency.signer.js';
import { witnessIntervalSeconds } from '@/config/key-transparency-env.js';
import { resolveHeadSigner } from '@/modules/transparency/transparency.signing-key.js';
import { TransparencyLog, TransparencyRepository } from '@/modules/transparency/index.js';
import { buildWitnessTargets, GithubWitnessTarget, WebhookWitnessTarget, WitnessPublisher, witnessBody } from '@/modules/transparency/transparency.witness.js';

describe('leaf encoding', () => {
  const leafId = leafIdOf('user-1');

  it('derives an opaque, stable and per-user leaf id', () => {
    expect(leafId).toHaveLength(32);
    expect(leafId.equals(leafIdOf('user-1'))).toBe(true);
    expect(leafId.equals(leafIdOf('user-2'))).toBe(false);
    expect(leafId.toString('hex')).not.toContain(Buffer.from('user-1').toString('hex'));
  });

  it('encodes canonically with length prefixes', () => {
    const encoded = encodeLeaf({ leafId, version: 3, identityKey: 'abc', signingKey: 'de' });
    expect(encoded.subarray(0, 1)).toEqual(Buffer.from([1]));
    expect(encoded.subarray(1, 33).equals(leafId)).toBe(true);
    expect(encoded.subarray(33, 37)).toEqual(Buffer.from([0, 0, 0, 3]));
    expect(encoded.subarray(37)).toEqual(Buffer.from([0, 3, 0x61, 0x62, 0x63, 0, 2, 0x64, 0x65]));
  });

  it('never lets one field bleed into the next', () => {
    const a = leafHashOf({ leafId, version: 1, identityKey: 'ab', signingKey: 'c' });
    const b = leafHashOf({ leafId, version: 1, identityKey: 'a', signingKey: 'bc' });
    expect(a.equals(b)).toBe(false);
  });

  it('distinguishes a missing signing key, another version and another user', () => {
    const base = leafHashOf({ leafId, version: 1, identityKey: 'k', signingKey: '' });
    expect(base.equals(leafHashOf({ leafId, version: 1, identityKey: 'k', signingKey: 's' }))).toBe(false);
    expect(base.equals(leafHashOf({ leafId, version: 2, identityKey: 'k', signingKey: '' }))).toBe(false);
    expect(base.equals(leafHashOf({ leafId: leafIdOf('user-2'), version: 1, identityKey: 'k', signingKey: '' }))).toBe(false);
  });

  it('rejects invalid leaves', () => {
    expect(() => encodeLeaf({ leafId, version: 0, identityKey: 'k', signingKey: '' })).toThrow();
    expect(() => encodeLeaf({ leafId, version: 1, identityKey: '', signingKey: '' })).toThrow();
    expect(() => encodeLeaf({ leafId, version: 1, identityKey: 'k'.repeat(256), signingKey: '' })).toThrow();
    expect(() => encodeLeaf({ leafId: Buffer.alloc(3), version: 1, identityKey: 'k', signingKey: '' })).toThrow();
  });
});

describe('known answers shared with the client', () => {
  it('matches the fixed vector used by the SPA tests', () => {
    expect(leafIdOf('user-1').toString('hex')).toBe('9ac7dff4ff7087807ddab3a71b19bb64cdd9e31eb82eff9de9aa4f35886ab2b8');
    expect(
      leafHashOf({ leafId: leafIdOf('user-1'), version: 2, identityKey: 'pub-key-1', signingKey: 'WxVi_oq1Q_DMJpBSIrYGqIMN84-KfUWmwVnqbavaJHA' }).toString('hex'),
    ).toBe('8311767ef97cc7fce481676e6db7b103026c3151a0f5b87de56efab8e83f6ce0');
    const signer = new TreeHeadSigner(parseSigningSeed(Buffer.alloc(32, 9).toString('base64url')));
    expect(signer.publicKey).toBe('_RckOFqgx1tk-3jNYC-h2ZH96_drE8WO1wLqyDXp9hg');
    expect(signer.sign(7, Buffer.alloc(32, 5), 1700000000000)).toEqual({
      size: 7,
      root: 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU',
      issuedAt: 1700000000000,
      signature: 'XmqF9oSMBUaK-GeXphIt7Pu_sO_LKtIX4L1hj7oeSYudMU_VJCFAu4ctWiM1dCerbwRWMnTXGEzRIAXnSziGDw',
    });
  });
});

describe('signed tree heads', () => {
  const signer = TreeHeadSigner.ephemeral();
  const root = Buffer.alloc(32, 7);

  it('verifies with the log public key', () => {
    expect(verifySignedTreeHead(signer.sign(5, root, 1000), signer.publicKey)).toBe(true);
  });

  it('is deterministic for the same input and key', () => {
    expect(signer.sign(5, root, 1000)).toEqual(signer.sign(5, root, 1000));
  });

  it('rejects another key, a changed size, root or time, and malformed values', () => {
    const head = signer.sign(5, root, 1000);
    expect(verifySignedTreeHead(head, TreeHeadSigner.ephemeral().publicKey)).toBe(false);
    expect(verifySignedTreeHead({ ...head, size: 6 }, signer.publicKey)).toBe(false);
    expect(verifySignedTreeHead({ ...head, issuedAt: 1001 }, signer.publicKey)).toBe(false);
    expect(verifySignedTreeHead({ ...head, root: Buffer.alloc(32, 8).toString('base64url') }, signer.publicKey)).toBe(false);
    expect(verifySignedTreeHead({ ...head, signature: 'short' }, signer.publicKey)).toBe(false);
    expect(verifySignedTreeHead(head, 'not*base64')).toBe(false);
  });

  it('keeps the signed bytes stable', () => {
    const bytes = headSigningBytes(1, Buffer.alloc(32, 1), 2);
    expect(bytes.subarray(0, 20).toString('utf8')).toBe('sparkchat:kt:sth:v1\n');
    expect(bytes).toHaveLength(20 + 8 + 32 + 8);
  });

  it('parses seeds strictly and rebuilds the same public key', () => {
    const seed = generateSigningSeed();
    expect(new TreeHeadSigner(parseSigningSeed(seed)).publicKey).toBe(new TreeHeadSigner(parseSigningSeed(seed)).publicKey);
    expect(() => parseSigningSeed('short')).toThrow(/32 bytes/);
    expect(() => parseSigningSeed('***')).toThrow();
  });
});

async function memoryRepository() {
  const client = createClient({ url: ':memory:' });
  const db = drizzle(client, { schema });
  await runMigrations(db);
  return new TransparencyRepository(db);
}

describe('log signing key resolution', () => {
  it('uses the configured key', async () => {
    const seed = generateSigningSeed();
    const signer = await resolveHeadSigner({ nodeEnv: 'production', KT_LOG_SIGNING_KEY: seed }, await memoryRepository());
    expect(signer.publicKey).toBe(new TreeHeadSigner(parseSigningSeed(seed)).publicKey);
  });

  it.each(['production', undefined, 'staging'])('refuses to invent or persist a key when NODE_ENV is %s', async (nodeEnv) => {
    const repo = await memoryRepository();
    await expect(resolveHeadSigner({ nodeEnv }, repo)).rejects.toThrow(/KT_LOG_SIGNING_KEY/);
    expect(await repo.getMeta('dev_signing_seed')).toBeNull();
  });

  it('generates a key once and persists it in development', async () => {
    const repo = await memoryRepository();
    const first = await resolveHeadSigner({ nodeEnv: 'development' }, repo);
    const second = await resolveHeadSigner({ nodeEnv: 'development' }, repo);
    expect(second.publicKey).toBe(first.publicKey);
  });

  it('keeps the test key in memory only', async () => {
    const repo = await memoryRepository();
    await resolveHeadSigner({ nodeEnv: 'test' }, repo);
    expect(await repo.getMeta('dev_signing_seed')).toBeNull();
  });
});

describe('persistent log', () => {
  async function build(now = () => 1_700_000_000_000) {
    const signer = TreeHeadSigner.ephemeral();
    return { log: new TransparencyLog(await memoryRepository(), signer, now), signer };
  }

  const bytes = (value: string) => Buffer.from(value, 'base64url');

  it('starts empty with the RFC empty root', async () => {
    const { log, signer } = await build();
    const head = await log.head();
    expect(head.size).toBe(0);
    expect(bytes(head.root).toString('hex')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(verifySignedTreeHead(head, signer.publicKey)).toBe(true);
  });

  it('matches an in-memory reference tree for every size and proof', async () => {
    const { log } = await build();
    const snapshots = Array.from({ length: 23 }, (_, i) => ({ userId: `user-${i}`, publicKey: `pub-${i}`, signingPublicKey: i % 2 ? `sign-${i}` : null }));
    const leafOf = (snapshot: (typeof snapshots)[number]) =>
      leafHashOf({ leafId: leafIdOf(snapshot.userId), version: 1, identityKey: snapshot.publicKey, signingKey: snapshot.signingPublicKey ?? '' });
    const reference = new MemoryNodeSource();
    for (const [i, snapshot] of snapshots.entries()) {
      await log.record(snapshot);
      reference.add([leafOf(snapshot)]);
      const head = await log.head();
      expect(bytes(head.root).equals(rootHash(reference, i + 1))).toBe(true);
    }
    const head = await log.head();
    for (const [i, snapshot] of snapshots.entries()) {
      const inclusion = await log.inclusion(snapshot, head);
      expect(inclusion?.position).toBe(i);
      expect(verifyInclusion(leafOf(snapshot), i, head.size, (inclusion?.proof ?? []).map(bytes), bytes(head.root))).toBe(true);
    }
    for (const first of [1, 5, 8, 16, 22]) {
      const proof = await log.consistency(first, 23);
      const firstRoot = await log.rootAt(first);
      expect(verifyConsistency(first, 23, firstRoot, bytes(head.root), ((proof === 'beyond' ? null : proof) ?? []).map(bytes))).toBe(true);
    }
  });

  it('appends a batch exactly like single appends', async () => {
    const first = await build();
    const second = await build();
    const snapshots = Array.from({ length: 19 }, (_, i) => ({ userId: `u${i}`, publicKey: `p${i}`, signingPublicKey: null }));
    for (const snapshot of snapshots) {
      await first.log.record(snapshot);
    }
    await second.log.recordMany(snapshots);
    expect((await first.log.head()).root).toBe((await second.log.head()).root);
  });

  it('skips unchanged keys and bumps the version on a change', async () => {
    const { log } = await build();
    expect(await log.record({ userId: 'u', publicKey: 'p', signingPublicKey: null })).toBe(true);
    expect(await log.record({ userId: 'u', publicKey: 'p', signingPublicKey: null })).toBe(false);
    expect(await log.record({ userId: 'u', publicKey: 'p', signingPublicKey: 's' })).toBe(true);
    const head = await log.head();
    const audit = await log.audit('u', head, 1, 10);
    expect(audit.entries.map((entry) => entry.version)).toEqual([1, 2]);
    expect(audit.truncated).toBe(false);
    expect((await log.audit('u', head, 1, 1)).truncated).toBe(true);
  });

  it('refuses consistency proofs for impossible ranges', async () => {
    const { log } = await build();
    await log.recordMany([{ userId: 'a', publicKey: 'p', signingPublicKey: null }]);
    expect(await log.consistency(0, 1)).toBeNull();
    expect(await log.consistency(2, 1)).toBeNull();
    expect(await log.consistency(1, 2)).toBe('beyond');
    expect(await log.consistency(1, 1)).toEqual([]);
  });

  it('does not expose entries added after the requested head size', async () => {
    const { log } = await build();
    await log.record({ userId: 'a', publicKey: 'p', signingPublicKey: null });
    const old = await log.head();
    await log.record({ userId: 'b', publicKey: 'p', signingPublicKey: null });
    expect(await log.inclusion({ userId: 'b', publicKey: 'p', signingPublicKey: null }, old)).toBeNull();
    expect((await log.audit('b', old, 1, 10)).entries).toEqual([]);
  });
});

describe('witness', () => {
  const head = TreeHeadSigner.ephemeral().sign(4, Buffer.alloc(32, 9), 1234);

  it('publishes only the signed head fields', () => {
    expect(JSON.parse(witnessBody(head))).toEqual({ v: 1, size: 4, root: head.root, issuedAt: 1234, signature: head.signature });
  });

  it('is disabled without targets and builds targets from env', () => {
    expect(buildWitnessTargets({})).toEqual([]);
    expect(buildWitnessTargets({ KT_WITNESS_GITHUB_REPOSITORY: 'o/r', KT_WITNESS_GITHUB_TOKEN: 't' })).toHaveLength(1);
    expect(buildWitnessTargets({ KT_WITNESS_WEBHOOK_URL: 'https://example.test/hook' })).toHaveLength(1);
    expect(buildWitnessTargets({ KT_WITNESS_GITHUB_REPOSITORY: 'o/r', KT_WITNESS_GITHUB_TOKEN: 't', KT_WITNESS_WEBHOOK_URL: 'https://e.test/h' })).toHaveLength(2);
    expect(new WitnessPublisher([], () => Promise.resolve(head), 1000).enabled).toBe(false);
  });

  it('creates the file on GitHub when it does not exist yet', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: url as string, ...(init ? { init } : {}) });
      return Promise.resolve(new Response('{}', { status: calls.length === 1 ? 404 : 201 }));
    }) as unknown as typeof fetch;
    await new GithubWitnessTarget({ repository: 'owner/witness', path: 'logs/head.json', branch: 'main', token: 'secret-token', fetchImpl }).publish('body');

    expect(calls[0]?.url).toBe('https://api.github.com/repos/owner/witness/contents/logs/head.json?ref=main');
    expect(calls[1]?.init?.method).toBe('PUT');
    const payload = JSON.parse(calls[1]?.init?.body as string) as { content: string; sha?: string; branch: string };
    expect(Buffer.from(payload.content, 'base64').toString()).toBe('body');
    expect(payload.sha).toBeUndefined();
    expect(payload.branch).toBe('main');
    expect((calls[1]?.init?.headers as Record<string, string>).authorization).toBe('Bearer secret-token');
  });

  it('updates the existing GitHub file using its sha', async () => {
    let call = 0;
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      call += 1;
      bodies.push(init?.body);
      return Promise.resolve(call === 1 ? new Response(JSON.stringify({ sha: 'abc123' }), { status: 200 }) : new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;
    await new GithubWitnessTarget({ repository: 'o/r', path: 'head.json', branch: 'main', token: 't', fetchImpl }).publish('x');
    expect((JSON.parse(bodies[1] as string) as { sha: string }).sha).toBe('abc123');
  });

  it('never leaks the token in errors', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('denied secret-token', { status: 403 }))) as unknown as typeof fetch;
    const target = new GithubWitnessTarget({ repository: 'o/r', path: 'head.json', branch: 'main', token: 'secret-token', fetchImpl });
    const error = (await target.publish('x').catch((reason: unknown) => reason)) as Error;
    expect(error.message).not.toContain('secret-token');
    expect(target.describe()).not.toContain('secret-token');
  });

  it('posts to a webhook with an optional bearer token', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('ok', { status: 200 }))) as unknown as typeof fetch;
    await new WebhookWitnessTarget({ url: 'https://example.test/hook', token: 'hook-token', fetchImpl }).publish('{"a":1}');
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer hook-token');
    expect(init.redirect).toBe('error');
  });

  describe('publisher', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('publishes new sizes once, skips the empty and unchanged tree, and retries after a failure', async () => {
      let size = 0;
      let failing = false;
      const published: string[] = [];
      const target = {
        describe: () => 'test',
        publish: (body: string) => {
          if (failing) {
            return Promise.reject(new Error('down'));
          }
          published.push(body);
          return Promise.resolve();
        },
      };
      const publisher = new WitnessPublisher([target], () => Promise.resolve({ ...head, size }), 1000);

      expect(await publisher.tick()).toBe(false);
      size = 4;
      expect(await publisher.tick()).toBe(true);
      expect(await publisher.tick()).toBe(false);
      size = 5;
      failing = true;
      expect(await publisher.tick()).toBe(false);
      failing = false;
      expect(await publisher.tick()).toBe(true);
      expect(published.map((body) => (JSON.parse(body) as { size: number }).size)).toEqual([4, 5]);
    });

    it('survives a failing head read', async () => {
      const publisher = new WitnessPublisher([{ describe: () => 't', publish: () => Promise.resolve() }], () => Promise.reject(new Error('db down')), 1000);
      expect(await publisher.tick()).toBe(false);
    });
  });
});

describe('environment', () => {
  const required = {
    RECOVERY_FILE_SECRET: 'a'.repeat(32),
    GEMINI_API_KEY: 'x',
    AI_ASSISTANT_PRIVATE_KEY: 'x',
    R2_ACCOUNT_ID: 'x',
    R2_ACCESS_KEY_ID: 'x',
    R2_SECRET_ACCESS_KEY: 'x',
    R2_BUCKET_NAME: 'x',
    R2_PUBLIC_BASE_URL: 'https://r2.test',
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load(overrides: Record<string, string>) {
    vi.resetModules();
    for (const key of ['KEY_TRANSPARENCY_ENABLED', 'KT_LOG_SIGNING_KEY', 'KT_WITNESS_GITHUB_REPOSITORY', 'KT_WITNESS_GITHUB_TOKEN', 'KT_WITNESS_WEBHOOK_URL', 'KT_WITNESS_INTERVAL_SECONDS']) {
      vi.stubEnv(key, '');
    }
    for (const [key, value] of Object.entries({ ...required, ...overrides })) {
      vi.stubEnv(key, value);
    }
    return (await import('@/config/env.js')).env;
  }

  it('keeps the feature off by default', async () => {
    expect((await load({ NODE_ENV: 'production' })).KEY_TRANSPARENCY_ENABLED).toBe(false);
  });

  it.each(['true', '1', 'TRUE', 'yes', 'on'])('turns on with %s', async (value) => {
    expect((await load({ NODE_ENV: 'development', KEY_TRANSPARENCY_ENABLED: value })).KEY_TRANSPARENCY_ENABLED).toBe(true);
  });

  it.each(['false', '0', '', 'off', 'nope'])('stays off with %s', async (value) => {
    expect((await load({ NODE_ENV: 'development', KEY_TRANSPARENCY_ENABLED: value })).KEY_TRANSPARENCY_ENABLED).toBe(false);
  });

  it('requires the log signing key outside development and test, including when NODE_ENV is unset', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(load({ NODE_ENV: 'production', KEY_TRANSPARENCY_ENABLED: 'true' })).rejects.toThrow();
    quiet.mockRestore();
    expect((await load({ NODE_ENV: 'production', KEY_TRANSPARENCY_ENABLED: 'true', KT_LOG_SIGNING_KEY: generateSigningSeed() })).KEY_TRANSPARENCY_ENABLED).toBe(true);
    expect((await load({ NODE_ENV: 'development', KEY_TRANSPARENCY_ENABLED: 'true' })).KEY_TRANSPARENCY_ENABLED).toBe(true);
    vi.resetModules();
    for (const [key, value] of Object.entries({ ...required, KEY_TRANSPARENCY_ENABLED: 'true' })) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv('NODE_ENV', undefined);
    delete process.env.NODE_ENV;
    const loud = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(import('@/config/env.js')).rejects.toThrow();
    loud.mockRestore();
  });

  it('fails with a clear message when the log signing key is malformed', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(load({ NODE_ENV: 'development', KEY_TRANSPARENCY_ENABLED: 'true', KT_LOG_SIGNING_KEY: 'not-a-key' })).rejects.toThrow();
    const reported = JSON.stringify(quiet.mock.calls);
    quiet.mockRestore();
    expect(reported).toContain('KT_LOG_SIGNING_KEY must be 32 random bytes encoded as base64url');
  });

  it('ignores every witness and key setting while the feature is off', async () => {
    const env = await load({
      NODE_ENV: 'production',
      KT_LOG_SIGNING_KEY: 'garbage',
      KT_WITNESS_GITHUB_REPOSITORY: '../etc',
      KT_WITNESS_WEBHOOK_URL: 'http://insecure.test/hook',
      KT_WITNESS_INTERVAL_SECONDS: 'abc',
    });
    expect(env.KEY_TRANSPARENCY_ENABLED).toBe(false);
  });

  it('validates the witness settings when the feature is on', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const base = { NODE_ENV: 'development', KEY_TRANSPARENCY_ENABLED: 'true' };
    await expect(load({ ...base, KT_WITNESS_GITHUB_REPOSITORY: 'o/r' })).rejects.toThrow();
    await expect(load({ ...base, KT_WITNESS_WEBHOOK_URL: 'http://insecure.test/hook' })).rejects.toThrow();
    await expect(load({ ...base, KT_WITNESS_GITHUB_REPOSITORY: '../etc', KT_WITNESS_GITHUB_TOKEN: 't' })).rejects.toThrow();
    await expect(load({ ...base, KT_WITNESS_INTERVAL_SECONDS: '5' })).rejects.toThrow();
    quiet.mockRestore();
    const env = await load({ ...base, KT_WITNESS_GITHUB_REPOSITORY: 'o/r', KT_WITNESS_GITHUB_TOKEN: 't' });
    expect(witnessIntervalSeconds(env.KT_WITNESS_INTERVAL_SECONDS)).toBe(300);
    expect(witnessIntervalSeconds('60')).toBe(60);
  });
});
