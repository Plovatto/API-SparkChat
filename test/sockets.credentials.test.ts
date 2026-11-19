import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { listSocketEvents } from '@/docs/socket-registry.js';
import { startSocketHarness, TEST_PASSWORD, waitForEvent } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

let harness: Harness | null = null;

async function start(): Promise<Harness> {
  harness = await startSocketHarness();
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function clientSecret(): string {
  return randomBytes(32).toString('base64url');
}

function authSalt(): string {
  return randomBytes(16).toString('base64url');
}

interface RegisteredPayload {
  user: { id: string };
  sessionToken: string;
  recoveryFile?: unknown;
  recoveryToken?: unknown;
}

describe('user:join register with v2 credentials', () => {
  it('creates a v2 account and sends no server recovery file', async () => {
    const h = await start();
    const client = await h.connect();
    const authKey = clientSecret();

    const registered = waitForEvent<RegisteredPayload>(client, 'user:registered');
    client.emit('user:join', {
      mode: 'register',
      nickname: 'Alice',
      avatar: 0,
      password: authKey,
      authSalt: authSalt(),
      recoveryVerifier: clientSecret(),
    });
    const payload = await registered;

    expect(payload).not.toHaveProperty('recoveryFile');
    expect(payload).not.toHaveProperty('recoveryToken');
    expect(payload.sessionToken).toBeTruthy();
    expect((await h.userRepository.findById(payload.user.id))?.authVersion).toBe(2);
  });

  it('rejects a plaintext password registration without v2 fields', async () => {
    const h = await start();
    const client = await h.connect();

    const failed = waitForEvent<{ mode: string; reason: string }>(client, 'user:auth-failed');
    client.emit('user:join', { mode: 'register', nickname: 'Alice', avatar: 0, password: 'a-plaintext-password-123' });

    expect(await failed).toMatchObject({ mode: 'register', reason: 'invalid' });
    expect(await h.userService.getUserByNickname('Alice')).toBeNull();
  });

  it('rejects a registration whose password is not a derived auth key', async () => {
    const h = await start();
    const client = await h.connect();

    const failed = waitForEvent<{ mode: string; reason: string }>(client, 'user:auth-failed');
    client.emit('user:join', {
      mode: 'register',
      nickname: 'Alice',
      avatar: 0,
      password: 'a-plaintext-password-123',
      authSalt: authSalt(),
      recoveryVerifier: clientSecret(),
    });

    expect(await failed).toMatchObject({ mode: 'register', reason: 'invalid' });
    expect(await h.userService.getUserByNickname('Alice')).toBeNull();
  });

  it('fails when only one of the v2 fields is sent', async () => {
    const h = await start();
    const client = await h.connect();

    const failed = waitForEvent<{ code: string }>(client, 'user:auth-failed');
    client.emit('user:join', { mode: 'register', nickname: 'Alice', avatar: 0, password: clientSecret(), authSalt: authSalt() });

    expect(await failed).toMatchObject({ mode: 'register', reason: 'invalid' });
  });
});

describe('removed legacy credential events', () => {
  it('ignores user:upgrade-credentials and leaves the account unchanged', async () => {
    const h = await start();
    const account = await h.createAccount('Alice');
    const client = await h.connectAs(account);
    const before = await h.userRepository.findById(account.user.id);

    let upgraded = false;
    client.on('user:credentials-upgraded' as never, () => {
      upgraded = true;
    });
    client.emit('user:upgrade-credentials' as never, {
      currentPassword: TEST_PASSWORD,
      newAuthSalt: authSalt(),
      newAuthKey: clientSecret(),
      encryptedPrivateKeyByPassword: 'wrapped-by-password',
      recoveryVerifier: clientSecret(),
      encryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
    });
    const keys = waitForEvent<{ authVersion: number }>(client, 'e2e:my-keys');
    client.emit('e2e:get-my-keys');
    await keys;

    expect(upgraded).toBe(false);
    expect(await h.userRepository.findById(account.user.id)).toMatchObject({ authSalt: before?.authSalt, passwordHash: before?.passwordHash });
    expect(listSocketEvents().some((event) => event.event === 'user:upgrade-credentials' || event.event === 'user:credentials-upgraded')).toBe(false);
  });
});

describe('v2 account socket flows', () => {
  async function upgradedAccount(h: Harness) {
    const account = await h.createAccount('Alice');
    await h.userRepository.update(account.user.id, {
      e2eEncryptedPrivateKeyByPassword: 'wrapped-by-password',
      e2eEncryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
    });
    return { ...account, authKey: TEST_PASSWORD };
  }

  it('changes the password with v2 fields and returns no recovery file', async () => {
    const h = await start();
    const account = await upgradedAccount(h);
    const client = await h.connectAs(account);

    const changed = waitForEvent<Record<string, unknown>>(client, 'user:password-changed');
    client.emit('user:change-password', {
      currentPassword: account.authKey,
      newPassword: clientSecret(),
      newAuthSalt: authSalt(),
      encryptedPrivateKeyByPassword: 'new-wrapped-by-password',
    });

    expect(await changed).toEqual({});
    expect((await h.userRepository.findById(account.user.id))?.e2eEncryptedPrivateKeyByPassword).toBe('new-wrapped-by-password');
  });

  it('regenerates the recovery verifier without a server file', async () => {
    const h = await start();
    const account = await upgradedAccount(h);
    const client = await h.connectAs(account);

    const regenerated = waitForEvent<Record<string, unknown>>(client, 'user:recovery-file-regenerated');
    client.emit('user:regenerate-recovery-file', {
      currentPassword: account.authKey,
      recoveryVerifier: clientSecret(),
      encryptedPrivateKeyByRecovery: 'new-wrapped-by-recovery',
    });

    expect(await regenerated).toEqual({});
  });

  it('changes the nickname without a recovery file and still disconnects other sessions', async () => {
    const h = await start();
    const account = await upgradedAccount(h);
    const client = await h.connectAs(account);
    const other = await h.userService.login('Alice', account.authKey);
    const otherClient = await h.connectAs({ user: account.user, sessionToken: other?.sessionToken ?? '' });

    const revoked = waitForEvent(otherClient, 'user:session-revoked');
    const updated = waitForEvent<Record<string, unknown>>(client, 'user:profile-updated-success');
    client.emit('user:update-profile', { nickname: 'Alicia', avatar: 0, currentPassword: account.authKey });

    const payload = await updated;
    expect(payload).not.toHaveProperty('recoveryFile');
    expect(payload).not.toHaveProperty('recoveryToken');
    await revoked;
  });

  it('rejects replacing published identity keys through e2e:publish-keys', async () => {
    const h = await start();
    const account = await upgradedAccount(h);
    const client = await h.connectAs(account);

    const error = waitForEvent<{ code: string; event?: string }>(client, 'error');
    client.emit('e2e:publish-keys', { encryptedPrivateKeyByPassword: 'attacker-wrap' });

    expect(await error).toMatchObject({ code: 'e2e.keysLocked', event: 'e2e:publish-keys' });
    expect((await h.userRepository.findById(account.user.id))?.e2eEncryptedPrivateKeyByPassword).toBe('wrapped-by-password');
  });

  it('reports version 2 in e2e:my-keys for every account', async () => {
    const h = await start();
    const account = await h.createAccount('Bob');
    const client = await h.connectAs(account);

    const keys = waitForEvent<{ authVersion: number }>(client, 'e2e:my-keys');
    client.emit('e2e:get-my-keys');

    expect(await keys).toMatchObject({ authVersion: 2 });
  });
});

describe('socket docs for v2 credentials', () => {
  it('documents only the v2 credential fields as required', () => {
    const events = listSocketEvents();
    const change = events.find((event) => event.event === 'user:change-password' && event.direction === 'client-to-server');
    const regenerate = events.find((event) => event.event === 'user:regenerate-recovery-file' && event.direction === 'client-to-server');

    expect(change?.payloadSchema).toMatchObject({
      required: expect.arrayContaining(['newPassword', 'newAuthSalt', 'encryptedPrivateKeyByPassword']) as unknown,
    });
    expect(regenerate?.payloadSchema).toMatchObject({
      required: expect.arrayContaining(['recoveryVerifier', 'encryptedPrivateKeyByRecovery']) as unknown,
    });
  });
});
