import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { identityBindingMessage } from '@/modules/users/user.signing-key.js';
import { leafHashOf, leafIdOf } from '@/modules/transparency/transparency.leaf.js';
import { verifyConsistency, verifyInclusion } from '@/modules/transparency/transparency.merkle.js';
import { verifySignedTreeHead, type SignedTreeHead } from '@/modules/transparency/transparency.signer.js';
import { startSocketHarness, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function signingIdentity(userId: string, publicKey: string) {
  const { publicKey: pub, privateKey } = generateKeyPairSync('ed25519');
  const raw = pub.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    signingPublicKey: raw.toString('base64url'),
    keySignature: sign(null, identityBindingMessage(userId, publicKey), privateKey).toString('base64url'),
  };
}

async function publishKeys(client: TestClient, userId: string, publicKey: string) {
  const signing = signingIdentity(userId, publicKey);
  client.emit('e2e:publish-keys', { publicKey, ...signing });
  await new Promise((resolve) => setTimeout(resolve, 120));
  return signing;
}

interface ProofsPayload {
  head: SignedTreeHead;
  proofs: ({ userId: string; found: true; position: number; version: number; proof: string[] } | { userId: string; found: false })[];
}

function checkInclusion(logPublicKey: string, payload: ProofsPayload, entry: { userId: string; publicKey: string; signingPublicKey?: string }): boolean {
  if (!verifySignedTreeHead(payload.head, logPublicKey)) {
    return false;
  }
  const result = payload.proofs.find((proof) => proof.userId === entry.userId);
  if (!result?.found) {
    return false;
  }
  const leaf = leafHashOf({
    leafId: leafIdOf(entry.userId),
    version: result.version,
    identityKey: entry.publicKey,
    signingKey: entry.signingPublicKey ?? '',
  });
  return verifyInclusion(
    leaf,
    result.position,
    payload.head.size,
    result.proof.map((value) => Buffer.from(value, 'base64url')),
    Buffer.from(payload.head.root, 'base64url'),
  );
}

async function nextProofs(client: TestClient, items: { userId: string; publicKey: string; signingPublicKey?: string }[]) {
  const reply = waitForEvent<ProofsPayload>(client, 'kt:proofs');
  client.emit('kt:get-proofs', { items });
  return reply;
}

describe('key transparency sockets', () => {
  describe('with the flag off', () => {
    it('advertises nothing and ignores transparency events', async () => {
      harness = await startSocketHarness();
      const account = await harness.createAccount('Alice');
      const client = await harness.connect();
      const received: string[] = [];
      for (const event of ['kt:config', 'kt:head', 'kt:proofs', 'error']) {
        client.on(event, () => received.push(event));
      }
      await harness.resume(client, account.user.id, account.sessionToken);
      client.emit('kt:get-head');
      client.emit('kt:get-proofs', { items: [{ userId: account.user.id, publicKey: 'x' }] });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(received).toEqual([]);
    });

    it('does not write to the log when keys are published', async () => {
      harness = await startSocketHarness();
      const account = await harness.createAccount('Alice');
      const client = await harness.connectAs(account);
      await publishKeys(client, account.user.id, 'pub-alice');
      const { TransparencyRepository } = await import('@/modules/transparency/index.js');
      expect(await new TransparencyRepository(harness.db).size()).toBe(0);
    });
  });

  describe('with the flag on', () => {
    it('advertises the log public key right after authentication', async () => {
      harness = await startSocketHarness({ transparency: true });
      const account = await harness.createAccount('Alice');
      const client = await harness.connect();
      const config = waitForEvent<{ enabled: boolean; logPublicKey: string }>(client, 'kt:config');
      await harness.resume(client, account.user.id, account.sessionToken);
      expect(await config).toEqual({ enabled: true, logPublicKey: harness.transparency?.signer.publicKey });
    });

    it('rejects every event from an unauthenticated socket', async () => {
      harness = await startSocketHarness({ transparency: true });
      const client = await harness.connect();
      for (const [event, payload] of [
        ['kt:get-head', undefined],
        ['kt:get-proofs', { items: [{ userId: 'u', publicKey: 'k' }] }],
        ['kt:get-consistency', { first: 1, second: 2 }],
        ['kt:audit', undefined],
        ['kt:gossip', { to: 'u', envelope: 'abc' }],
      ] as const) {
        const error = waitForEvent<{ code: string }>(client, 'error');
        client.emit(event, payload);
        expect(await error).toMatchObject({ code: 'auth.unauthenticated' });
      }
    });

    it('logs a key publication and proves it against a signed head', async () => {
      harness = await startSocketHarness({ transparency: true });
      const account = await harness.createAccount('Alice');
      const client = await harness.connectAs(account);
      const signing = await publishKeys(client, account.user.id, 'pub-alice');
      const logKey = harness.transparency?.signer.publicKey as string;

      const entry = { userId: account.user.id, publicKey: 'pub-alice', signingPublicKey: signing.signingPublicKey };
      const payload = await nextProofs(client, [entry]);

      expect(checkInclusion(logKey, payload, entry)).toBe(true);
      expect(payload.head.size).toBe(1);
    });

    it('records a key set in two steps as two versions of the same leaf id', async () => {
      harness = await startSocketHarness({ transparency: true });
      const account = await harness.createAccount('Alice');
      const client = await harness.connectAs(account);
      client.emit('e2e:publish-keys', { publicKey: 'pub-alice' });
      await new Promise((resolve) => setTimeout(resolve, 120));
      const signing = signingIdentity(account.user.id, 'pub-alice');
      client.emit('e2e:publish-signing-key', signing);
      await new Promise((resolve) => setTimeout(resolve, 120));

      const audit = waitForEvent<{
        head: SignedTreeHead;
        entries: { position: number; version: number; publicKey: string; signingPublicKey: string | null; proof: string[] }[];
      }>(client, 'kt:audit');
      client.emit('kt:audit');
      const result = await audit;

      expect(result.entries.map((entry) => [entry.version, entry.publicKey, entry.signingPublicKey])).toEqual([
        [1, 'pub-alice', null],
        [2, 'pub-alice', signing.signingPublicKey],
      ]);
      expect(verifySignedTreeHead(result.head, harness.transparency?.signer.publicKey as string)).toBe(true);
      for (const entry of result.entries) {
        const leaf = leafHashOf({ leafId: leafIdOf(account.user.id), version: entry.version, identityKey: entry.publicKey, signingKey: entry.signingPublicKey ?? '' });
        expect(
          verifyInclusion(leaf, entry.position, result.head.size, entry.proof.map((p) => Buffer.from(p, 'base64url')), Buffer.from(result.head.root, 'base64url')),
        ).toBe(true);
      }
    });

    it('does not record the same keys twice', async () => {
      harness = await startSocketHarness({ transparency: true });
      const account = await harness.createAccount('Alice');
      const client = await harness.connectAs(account);
      const signing = await publishKeys(client, account.user.id, 'pub-alice');
      client.emit('e2e:publish-signing-key', signing);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(await harness.transparency?.log.size()).toBe(1);
    });

    it('does not prove a tampered key, a tampered signing key or an unknown user', async () => {
      harness = await startSocketHarness({ transparency: true });
      const account = await harness.createAccount('Alice');
      const client = await harness.connectAs(account);
      const signing = await publishKeys(client, account.user.id, 'pub-alice');

      const tampered = await nextProofs(client, [
        { userId: account.user.id, publicKey: 'pub-mallory', signingPublicKey: signing.signingPublicKey },
      ]);
      expect(tampered.proofs).toEqual([{ userId: account.user.id, found: false }]);

      const noSigning = await nextProofs(client, [{ userId: account.user.id, publicKey: 'pub-alice' }]);
      expect(noSigning.proofs).toEqual([{ userId: account.user.id, found: false }]);

      const unknown = await nextProofs(client, [{ userId: 'someone-else', publicKey: 'pub-alice', signingPublicKey: signing.signingPublicKey }]);
      expect(unknown.proofs).toEqual([{ userId: 'someone-else', found: false }]);
    });

    it('rejects a proof checked against another leaf, another root or a forged head signature', async () => {
      harness = await startSocketHarness({ transparency: true });
      const account = await harness.createAccount('Alice');
      const other = await harness.createAccount('Bob');
      const clientA = await harness.connectAs(account);
      const clientB = await harness.connectAs(other);
      const signingA = await publishKeys(clientA, account.user.id, 'pub-alice');
      const signingB = await publishKeys(clientB, other.user.id, 'pub-bob');
      const logKey = harness.transparency?.signer.publicKey as string;
      const entryA = { userId: account.user.id, publicKey: 'pub-alice', signingPublicKey: signingA.signingPublicKey };
      const entryB = { userId: other.user.id, publicKey: 'pub-bob', signingPublicKey: signingB.signingPublicKey };

      const payload = await nextProofs(clientA, [entryA, entryB]);
      expect(checkInclusion(logKey, payload, entryA)).toBe(true);
      expect(checkInclusion(logKey, payload, entryB)).toBe(true);
      expect(checkInclusion(logKey, payload, { ...entryA, publicKey: 'pub-bob' })).toBe(false);
      expect(checkInclusion(logKey, { ...payload, head: { ...payload.head, root: Buffer.alloc(32).toString('base64url') } }, entryA)).toBe(false);
      expect(checkInclusion(logKey, { ...payload, head: { ...payload.head, size: payload.head.size + 1 } }, entryA)).toBe(false);
      const otherLog = (await import('@/modules/transparency/transparency.signer.js')).TreeHeadSigner.ephemeral().publicKey;
      expect(checkInclusion(otherLog, payload, entryA)).toBe(false);
    });

    it('proves inclusion at an earlier tree size and does not find later entries there', async () => {
      harness = await startSocketHarness({ transparency: true });
      const alice = await harness.createAccount('Alice');
      const bob = await harness.createAccount('Bob');
      const clientA = await harness.connectAs(alice);
      const clientB = await harness.connectAs(bob);
      const signingA = await publishKeys(clientA, alice.user.id, 'pub-alice');
      const signingB = await publishKeys(clientB, bob.user.id, 'pub-bob');
      const logKey = harness.transparency?.signer.publicKey as string;
      const entryA = { userId: alice.user.id, publicKey: 'pub-alice', signingPublicKey: signingA.signingPublicKey };
      const entryB = { userId: bob.user.id, publicKey: 'pub-bob', signingPublicKey: signingB.signingPublicKey };

      const reply = waitForEvent<ProofsPayload>(clientA, 'kt:proofs');
      clientA.emit('kt:get-proofs', { treeSize: 1, items: [entryA, entryB] });
      const payload = await reply;

      expect(payload.head.size).toBe(1);
      expect(checkInclusion(logKey, payload, entryA)).toBe(true);
      expect(payload.proofs.find((proof) => proof.userId === bob.user.id)).toMatchObject({ found: false });
    });

    it('repairs a missing entry on demand only when it matches the stored keys', async () => {
      harness = await startSocketHarness({ transparency: true });
      const account = await harness.createAccount('Alice');
      const client = await harness.connectAs(account);
      const signing = signingIdentity(account.user.id, 'pub-direct');
      await harness.userRepository.update(account.user.id, {
        e2ePublicKey: 'pub-direct',
        e2eSigningPublicKey: signing.signingPublicKey,
        e2eKeySignature: signing.keySignature,
      });
      const logKey = harness.transparency?.signer.publicKey as string;
      const entry = { userId: account.user.id, publicKey: 'pub-direct', signingPublicKey: signing.signingPublicKey };

      const forged = await nextProofs(client, [{ ...entry, publicKey: 'pub-forged' }]);
      expect(forged.proofs[0]).toMatchObject({ found: false });
      expect(await harness.transparency?.log.size()).toBe(0);

      const repaired = await nextProofs(client, [entry]);
      expect(checkInclusion(logKey, repaired, entry)).toBe(true);
    });

    it('serves consistency proofs between heads and refuses impossible sizes', async () => {
      harness = await startSocketHarness({ transparency: true });
      const clients: { id: string; client: TestClient }[] = [];
      for (let i = 0; i < 6; i += 1) {
        const account = await harness.createAccount(`User${String.fromCharCode(65 + i)}`);
        const client = await harness.connectAs(account);
        clients.push({ id: account.user.id, client });
      }
      const first = clients[0] as { id: string; client: TestClient };
      await publishKeys(first.client, first.id, 'pub-0');
      const earlier = await new Promise<{ head: SignedTreeHead }>((resolve) => {
        first.client.once('kt:head', resolve);
        first.client.emit('kt:get-head');
      });
      for (let i = 1; i < clients.length; i += 1) {
        const item = clients[i] as { id: string; client: TestClient };
        await publishKeys(item.client, item.id, `pub-${i}`);
      }
      const later = await new Promise<{ head: SignedTreeHead }>((resolve) => {
        first.client.once('kt:head', resolve);
        first.client.emit('kt:get-head');
      });
      expect(earlier.head.size).toBe(1);
      expect(later.head.size).toBe(6);

      const consistency = waitForEvent<{ proof: string[] }>(first.client, 'kt:consistency');
      first.client.emit('kt:get-consistency', { first: 1, second: 6 });
      const { proof } = await consistency;
      expect(
        verifyConsistency(1, 6, Buffer.from(earlier.head.root, 'base64url'), Buffer.from(later.head.root, 'base64url'), proof.map((p) => Buffer.from(p, 'base64url'))),
      ).toBe(true);
      expect(
        verifyConsistency(1, 6, Buffer.from(later.head.root, 'base64url'), Buffer.from(earlier.head.root, 'base64url'), proof.map((p) => Buffer.from(p, 'base64url'))),
      ).toBe(false);

      const beyond = waitForEvent<{ proof: string[] | null }>(first.client, 'kt:consistency');
      first.client.emit('kt:get-consistency', { first: 1, second: 7 });
      expect((await beyond).proof).toBeNull();

      for (const payload of [{ first: 3, second: 2 }, { first: 0, second: 2 }]) {
        const error = waitForEvent<{ code: string }>(first.client, 'error');
        first.client.emit('kt:get-consistency', payload);
        expect(await error).toMatchObject({ event: 'kt:get-consistency' });
      }
    });

    it('audits only the caller entries and never lists other users', async () => {
      harness = await startSocketHarness({ transparency: true });
      const alice = await harness.createAccount('Alice');
      const bob = await harness.createAccount('Bob');
      const clientA = await harness.connectAs(alice);
      const clientB = await harness.connectAs(bob);
      await publishKeys(clientA, alice.user.id, 'pub-alice');
      await publishKeys(clientB, bob.user.id, 'pub-bob');

      const audit = waitForEvent<{ entries: { publicKey: string }[] }>(clientA, 'kt:audit');
      clientA.emit('kt:audit', { fromVersion: 1, userId: bob.user.id });
      expect((await audit).entries.map((entry) => entry.publicKey)).toEqual(['pub-alice']);
    });

    it('rejects oversized and malformed requests', async () => {
      harness = await startSocketHarness({ transparency: true });
      const account = await harness.createAccount('Alice');
      const client = await harness.connectAs(account);
      const items = Array.from({ length: 51 }, (_, i) => ({ userId: `u${i}`, publicKey: 'k' }));
      for (const [event, payload] of [
        ['kt:get-proofs', { items }],
        ['kt:get-proofs', { items: [] }],
        ['kt:get-proofs', { items: [{ userId: 'u', publicKey: 'k'.repeat(201) }] }],
        ['kt:get-proofs', { items: [{ userId: 'u', publicKey: 'k', signingPublicKey: '***' }] }],
        ['kt:get-consistency', { first: 1.5, second: 2 }],
        ['kt:audit', { fromVersion: 0 }],
        ['kt:gossip', { to: 'u', envelope: 'a'.repeat(2049) }],
        ['kt:gossip', { to: 'u', envelope: 'not base64!' }],
      ] as const) {
        const error = waitForEvent<{ event?: string }>(client, 'error');
        client.emit(event, payload);
        expect(await error).toMatchObject({ event });
      }
    });

    it('rate limits transparency events', async () => {
      harness = await startSocketHarness({
        transparency: true,
        socketEventBudgets: { events: { 'kt:get-head': { capacity: 2, refillPerSecond: 0.001 } }, fallback: { capacity: 100, refillPerSecond: 100 } },
      });
      const account = await harness.createAccount('Alice');
      const client = await harness.connectAs(account);
      const heads: unknown[] = [];
      client.on('kt:head', (payload) => heads.push(payload));
      for (let i = 0; i < 6; i += 1) {
        client.emit('kt:get-head');
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(heads.length).toBe(2);
    });

    it('relays gossip only between contacts', async () => {
      harness = await startSocketHarness({ transparency: true });
      const alice = await harness.createAccount('Alice');
      const bob = await harness.createAccount('Bob');
      const carol = await harness.createAccount('Carol');
      const clientA = await harness.connectAs(alice);
      const clientB = await harness.connectAs(bob);
      const clientC = await harness.connectAs(carol);
      const group = await harness.roomService.createGroupRoom(alice.user.id);
      await harness.joinGroup(group.id, bob.user.id);

      const toBob = waitForEvent<{ from: string; envelope: string }>(clientB, 'kt:gossip');
      clientA.emit('kt:gossip', { to: bob.user.id, envelope: 'AAAA' });
      expect(await toBob).toEqual({ from: alice.user.id, envelope: 'AAAA' });

      const leaked: unknown[] = [];
      clientC.on('kt:gossip', (payload) => leaked.push(payload));
      const denied = waitForEvent<{ code: string }>(clientA, 'error');
      clientA.emit('kt:gossip', { to: carol.user.id, envelope: 'AAAA' });
      expect(await denied).toMatchObject({ code: 'e2e.transparencyInvalid' });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(leaked).toEqual([]);
    });

    it('keeps the tree consistent when many users publish at once', async () => {
      harness = await startSocketHarness({ transparency: true });
      const h = harness;
      const accounts = await Promise.all(Array.from({ length: 12 }, (_, i) => h.createAccount(`Racer${String.fromCharCode(65 + i)}`)));
      const clients = await Promise.all(accounts.map((account) => h.connectAs(account)));
      await Promise.all(clients.map((client, i) => publishKeys(client, (accounts[i] as (typeof accounts)[number]).user.id, `pub-${i}`)));
      expect(await harness.transparency?.log.size()).toBe(12);
      const head = await harness.transparency?.log.head();
      const client = clients[0] as TestClient;
      const items = await Promise.all(
        accounts.map(async (account, i) => {
          const user = await harness?.userRepository.findById((account).user.id);
          return { userId: (account).user.id, publicKey: `pub-${i}`, signingPublicKey: user?.e2eSigningPublicKey as string };
        }),
      );
      const payload = await nextProofs(client, items);
      for (const item of items) {
        expect(checkInclusion(harness.transparency?.signer.publicKey as string, payload, item)).toBe(true);
      }
      expect(payload.head.size).toBe(head?.size);
    }, 30_000);
  });

  describe('backfill', () => {
    it('adds existing keyed users once and is idempotent', async () => {
      harness = await startSocketHarness({ transparency: true });
      for (let i = 0; i < 5; i += 1) {
        const account = await harness.createAccount(`Old${String.fromCharCode(65 + i)}`);
        await harness.userRepository.update(account.user.id, { e2ePublicKey: `pub-old-${i}` });
      }
      await harness.createAccount('NoKeys');

      expect(await harness.transparency?.service.backfill()).toBe(5);
      expect(await harness.transparency?.service.backfill()).toBe(0);
      expect(await harness.transparency?.log.size()).toBe(5);
    });
  });
});
