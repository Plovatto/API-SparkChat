import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { identityBindingMessage, verifyIdentityBinding } from '@/modules/users/user.signing-key.js';
import { startSocketHarness, waitForEvent } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

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
    await settle();
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

    const error = waitForEvent<{ code?: string; event?: string }>(client, 'error');
    client.emit('e2e:publish-signing-key', { signingPublicKey: 'short', keySignature: 'short' });

    expect(await error).toMatchObject({ event: 'e2e:publish-signing-key' });
  });

  it('is idempotent for the same key and locked against a different one', async () => {
    harness = await startSocketHarness();
    const { account, client } = await accountWithKey(harness, 'Alice', 'pub-alice');
    const first = signingIdentity(account.user.id, 'pub-alice');
    const second = signingIdentity(account.user.id, 'pub-alice');

    client.emit('e2e:publish-signing-key', { signingPublicKey: first.signingPublicKey, keySignature: first.keySignature });
    await settle();
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
    await settle();
    expect((await harness.userRepository.findById(account.user.id))?.e2eSigningPublicKey).toBe(signing.signingPublicKey);

    client.emit('e2e:publish-keys', { publicKey: 'pub-alice-new' });
    await settle();

    const after = await harness.userRepository.findById(account.user.id);
    expect(after?.e2ePublicKey).toBe('pub-alice-new');
    expect(after?.e2eSigningPublicKey).toBeNull();
    expect(after?.e2eKeySignature).toBeNull();
  });

  it('accepts the signing key together with the public key in e2e:publish-keys', async () => {
    harness = await startSocketHarness();
    const account = await harness.createAccount('Carol');
    const client = await harness.connectAs(account);
    const signing = signingIdentity(account.user.id, 'pub-carol');

    client.emit('e2e:publish-keys', { publicKey: 'pub-carol', signingPublicKey: signing.signingPublicKey, keySignature: signing.keySignature });
    await settle();

    const stored = await harness.userRepository.findById(account.user.id);
    expect(stored).toMatchObject({ e2ePublicKey: 'pub-carol', e2eSigningPublicKey: signing.signingPublicKey, e2eKeySignature: signing.keySignature });
  });

  it('rejects a combined publish whose signature does not match the new public key and stores nothing', async () => {
    harness = await startSocketHarness();
    const account = await harness.createAccount('Dave');
    const client = await harness.connectAs(account);
    const signing = signingIdentity(account.user.id, 'another-pub');

    const error = waitForEvent<{ code: string; event?: string }>(client, 'error');
    client.emit('e2e:publish-keys', { publicKey: 'pub-dave', signingPublicKey: signing.signingPublicKey, keySignature: signing.keySignature });

    expect(await error).toMatchObject({ code: 'e2e.invalidSigningKey', event: 'e2e:publish-keys' });
    expect((await harness.userRepository.findById(account.user.id))?.e2ePublicKey).toBeFalsy();
  });

  it('rejects a payload with only one of the two signing fields', async () => {
    harness = await startSocketHarness();
    const { client } = await accountWithKey(harness, 'Eve', 'pub-eve');

    const error = waitForEvent<{ message?: string }>(client, 'error');
    client.emit('e2e:publish-keys', { publicKey: 'pub-eve-2', signingPublicKey: 'A'.repeat(43) });

    expect(await error).toBeTruthy();
  });

  it('binds the signature to a fixed message format shared with the client', () => {
    expect(identityBindingMessage('user-1', 'pk').toString('utf8')).toBe('sparkchat:identity-binding:v1:user-1:pk');
  });

  it('verifies the fixed vector produced by the client implementation', () => {
    expect(
      verifyIdentityBinding({
        userId: 'user-1',
        publicKey: 'pub-key-1',
        signingPublicKey: 'WxVi_oq1Q_DMJpBSIrYGqIMN84-KfUWmwVnqbavaJHA',
        keySignature: 'Xcv5CvLuYmXUiiHaceCx47Z3ZiK_Hocigs6Nx-j8YLVUwR8mw5slD-DRyEt8osJflasWLbD2cXV10ub8FzF_Dw',
      }),
    ).toBe(true);
  });

  it('keeps room keys when a key change arrives with an invalid signing proof', async () => {
    harness = await startSocketHarness();
    const h = harness;
    const { account, client } = await accountWithKey(h, 'Frank', 'pub-frank');
    const other = await h.createAccount('Grace');
    const room = await h.roomService.createPrivateRoom(account.user.id, other.user.id);
    await h.roomKeyRepository.publish(room.id, account.user.id, 'sealed');
    const signing = signingIdentity(account.user.id, 'unrelated');

    const error = waitForEvent<{ code: string }>(client, 'error');
    client.emit('e2e:publish-keys', { publicKey: 'pub-frank-new', signingPublicKey: signing.signingPublicKey, keySignature: signing.keySignature });

    expect(await error).toMatchObject({ code: 'e2e.invalidSigningKey' });
    expect((await h.userRepository.findById(account.user.id))?.e2ePublicKey).toBe('pub-frank');
    expect(await h.roomKeyRepository.findForUser(room.id, account.user.id)).toBe('sealed');
  });

  it('rejects a different signing key through e2e:publish-keys once one is stored', async () => {
    harness = await startSocketHarness();
    const { account, client } = await accountWithKey(harness, 'Heidi', 'pub-heidi');
    const first = signingIdentity(account.user.id, 'pub-heidi');
    const second = signingIdentity(account.user.id, 'pub-heidi');
    client.emit('e2e:publish-signing-key', { signingPublicKey: first.signingPublicKey, keySignature: first.keySignature });
    await settle();

    const error = waitForEvent<{ code: string }>(client, 'error');
    client.emit('e2e:publish-keys', { signingPublicKey: second.signingPublicKey, keySignature: second.keySignature });

    expect(await error).toMatchObject({ code: 'e2e.signingKeyLocked' });
  });

  it('omits the signing fields for peers without a signing key', async () => {
    harness = await startSocketHarness();
    const { account, client } = await accountWithKey(harness, 'Ivan', 'pub-ivan');

    const keys = waitForEvent<{ keys: Record<string, unknown>[] }>(client, 'e2e:public-keys');
    client.emit('e2e:get-public-keys', { userIds: [account.user.id] });

    expect((await keys).keys[0]).toEqual({ userId: account.user.id, publicKey: 'pub-ivan' });
  });

  it('keeps exactly one signing key when two different valid keys are published concurrently', async () => {
    harness = await startSocketHarness();
    const h = harness;
    const { account } = await accountWithKey(h, 'Judy', 'pub-judy');
    const first = signingIdentity(account.user.id, 'pub-judy');
    const second = signingIdentity(account.user.id, 'pub-judy');

    const results = await Promise.allSettled([
      h.userService.publishSigningKey(account.user.id, first),
      h.userService.publishSigningKey(account.user.id, second),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const stored = (await h.userRepository.findById(account.user.id))?.e2eSigningPublicKey;
    expect([first.signingPublicKey, second.signingPublicKey]).toContain(stored);
  });
});
