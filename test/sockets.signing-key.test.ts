import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { identityBindingMessage } from '@/modules/users/user.signing-key.js';
import { startSocketHarness, waitForEvent } from './support/socket-harness.js';

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
    privateKey,
  };
}

async function accountWithKey(h: Harness, nickname: string, publicKey: string) {
  const account = await h.createAccount(nickname);
  const client = await h.connectAs(account);
  await h.userRepository.update(account.user.id, { e2ePublicKey: publicKey });
  return { account, client };
}

describe('e2e:publish-signing-key', () => {
  it('stores a valid signing key and exposes it through e2e:get-public-keys and e2e:get-my-keys', async () => {
    harness = await startSocketHarness();
    const h = harness;
    const { account, client } = await accountWithKey(h, 'Alice', 'pub-alice');
    const signing = signingIdentity(account.user.id, 'pub-alice');

    client.emit('e2e:publish-signing-key', { signingPublicKey: signing.signingPublicKey, keySignature: signing.keySignature });
    const keys = waitForEvent<{ keys: { userId: string; signingPublicKey?: string; keySignature?: string }[] }>(client, 'e2e:public-keys');
    await new Promise((resolve) => setTimeout(resolve, 150));
    client.emit('e2e:get-public-keys', { userIds: [account.user.id] });

    expect((await keys).keys[0]).toMatchObject({ userId: account.user.id, signingPublicKey: signing.signingPublicKey, keySignature: signing.keySignature });

    const mine = waitForEvent<{ signingPublicKey: string | null }>(client, 'e2e:my-keys');
    client.emit('e2e:get-my-keys');
    expect(await mine).toMatchObject({ signingPublicKey: signing.signingPublicKey });
  });

  it('rejects a signature made over a different public key', async () => {
    harness = await startSocketHarness();
    const { account, client } = await accountWithKey(harness, 'Alice', 'pub-alice');
    const signing = signingIdentity(account.user.id, 'other-pub');

    const error = waitForEvent<{ code: string; event?: string }>(client, 'error');
    client.emit('e2e:publish-signing-key', { signingPublicKey: signing.signingPublicKey, keySignature: signing.keySignature });

    expect(await error).toMatchObject({ code: 'e2e.invalidSigningKey', event: 'e2e:publish-signing-key' });
    expect((await harness.userRepository.findById(account.user.id))?.e2eSigningPublicKey).toBeNull();
  });

  it('rejects a signature bound to another user id', async () => {
    harness = await startSocketHarness();
    const { client } = await accountWithKey(harness, 'Alice', 'pub-alice');
    const signing = signingIdentity('someone-else', 'pub-alice');

    const error = waitForEvent<{ code: string }>(client, 'error');
    client.emit('e2e:publish-signing-key', { signingPublicKey: signing.signingPublicKey, keySignature: signing.keySignature });

    expect(await error).toMatchObject({ code: 'e2e.invalidSigningKey' });
  });

  it('rejects malformed values at the schema level', async () => {
    harness = await startSocketHarness();
    const { client } = await accountWithKey(harness, 'Alice', 'pub-alice');

    const error = waitForEvent<{ code?: string }>(client, 'error');
    client.emit('e2e:publish-signing-key', { signingPublicKey: 'short', keySignature: 'short' });

    expect(await error).toBeTruthy();
  });

  it('is idempotent for the same key and locked against a different one', async () => {
    harness = await startSocketHarness();
    const { account, client } = await accountWithKey(harness, 'Alice', 'pub-alice');
    const first = signingIdentity(account.user.id, 'pub-alice');
    const second = signingIdentity(account.user.id, 'pub-alice');

    client.emit('e2e:publish-signing-key', { signingPublicKey: first.signingPublicKey, keySignature: first.keySignature });
    await new Promise((resolve) => setTimeout(resolve, 150));
    client.emit('e2e:publish-signing-key', { signingPublicKey: first.signingPublicKey, keySignature: first.keySignature });

    const error = waitForEvent<{ code: string }>(client, 'error');
    client.emit('e2e:publish-signing-key', { signingPublicKey: second.signingPublicKey, keySignature: second.keySignature });

    expect(await error).toMatchObject({ code: 'e2e.signingKeyLocked' });
    expect((await harness.userRepository.findById(account.user.id))?.e2eSigningPublicKey).toBe(first.signingPublicKey);
  });

  it('rejects publishing before any public key exists', async () => {
    harness = await startSocketHarness();
    const account = await harness.createAccount('Bob');
    const client = await harness.connectAs(account);
    const signing = signingIdentity(account.user.id, 'pub-bob');

    const error = waitForEvent<{ code: string }>(client, 'error');
    client.emit('e2e:publish-signing-key', { signingPublicKey: signing.signingPublicKey, keySignature: signing.keySignature });

    expect(await error).toMatchObject({ code: 'e2e.invalidSigningKey' });
  });

  it('clears the signing key when a legacy account replaces its public key', async () => {
    harness = await startSocketHarness();
    const { account, client } = await accountWithKey(harness, 'Alice', 'pub-alice');
    const signing = signingIdentity(account.user.id, 'pub-alice');
    client.emit('e2e:publish-signing-key', { signingPublicKey: signing.signingPublicKey, keySignature: signing.keySignature });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await harness.userRepository.findById(account.user.id))?.e2eSigningPublicKey).toBe(signing.signingPublicKey);

    client.emit('e2e:publish-keys', { publicKey: 'pub-alice-new' });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const after = await harness.userRepository.findById(account.user.id);
    expect(after?.e2ePublicKey).toBe('pub-alice-new');
    expect(after?.e2eSigningPublicKey).toBeNull();
    expect(after?.e2eKeySignature).toBeNull();
  });
});
