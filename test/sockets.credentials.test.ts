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

function upgradePayload(currentPassword: string) {
  return {
    currentPassword,
    newAuthSalt: authSalt(),
    newAuthKey: clientSecret(),
    encryptedPrivateKeyByPassword: 'wrapped-by-password',
    recoveryVerifier: clientSecret(),
    encryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
  };
}

interface RegisteredPayload {
  user: { id: string };
  sessionToken: string;
  recoveryFile: string | null;
  recoveryToken: string | null;
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

    expect(payload.recoveryFile).toBeNull();
    expect(payload.recoveryToken).toBeNull();
    expect(payload.sessionToken).toBeTruthy();
    expect((await h.userRepository.findById(payload.user.id))?.authVersion).toBe(2);
  });

  it('keeps sending the server recovery file to legacy clients', async () => {
    const h = await start();
    const client = await h.connect();

    const registered = waitForEvent<RegisteredPayload>(client, 'user:registered');
    client.emit('user:join', { mode: 'register', nickname: 'Alice', avatar: 0, password: TEST_PASSWORD });
    const payload = await registered;

    expect(payload.recoveryFile).toBeTruthy();
    expect(payload.recoveryToken).toBeTruthy();
  });

  it('fails when only one of the v2 fields is sent', async () => {
    const h = await start();
    const client = await h.connect();

    const failed = waitForEvent<{ code: string }>(client, 'user:auth-failed');
    client.emit('user:join', { mode: 'register', nickname: 'Alice', avatar: 0, password: clientSecret(), authSalt: authSalt() });

    expect(await failed).toMatchObject({ mode: 'register', code: 'user.credentialsIncomplete' });
  });
});

describe('user:upgrade-credentials', () => {
  it('upgrades a legacy account, keeps the socket session and reports version 2', async () => {
    const h = await start();
    const account = await h.createAccount('Alice');
    const client = await h.connectAs(account);
    const payload = upgradePayload(TEST_PASSWORD);

    const upgraded = waitForEvent<{ authVersion: number }>(client, 'user:credentials-upgraded');
    client.emit('user:upgrade-credentials', payload);

    expect(await upgraded).toEqual({ authVersion: 2 });
    expect(await h.userRepository.findById(account.user.id)).toMatchObject({ authVersion: 2, authSalt: payload.newAuthSalt });
    expect(await h.userService.isSessionActive(account.user.id, account.sessionId)).toBe(true);

    const keys = waitForEvent<{ authVersion: number }>(client, 'e2e:my-keys');
    client.emit('e2e:get-my-keys');
    expect(await keys).toMatchObject({ authVersion: 2, encryptedPrivateKeyByPassword: 'wrapped-by-password' });
  });

  it('rejects a wrong current password', async () => {
    const h = await start();
    const account = await h.createAccount('Alice');
    const client = await h.connectAs(account);

    const error = waitForEvent<{ code: string; event?: string }>(client, 'error');
    client.emit('user:upgrade-credentials', upgradePayload('wrong-password-123'));

    expect(await error).toMatchObject({ code: 'user.currentPasswordIncorrect', event: 'user:upgrade-credentials' });
    expect((await h.userRepository.findById(account.user.id))?.authVersion).toBe(1);
  });

  it('rejects accounts that already use v2', async () => {
    const h = await start();
    const account = await h.createAccount('Alice');
    const client = await h.connectAs(account);
    const first = upgradePayload(TEST_PASSWORD);
    const upgraded = waitForEvent(client, 'user:credentials-upgraded');
    client.emit('user:upgrade-credentials', first);
    await upgraded;

    const error = waitForEvent<{ code: string }>(client, 'error');
    client.emit('user:upgrade-credentials', upgradePayload(first.newAuthKey));

    expect(await error).toMatchObject({ code: 'user.credentialsAlreadyUpgraded' });
  });

  it('rejects payloads with malformed derived values', async () => {
    const h = await start();
    const account = await h.createAccount('Alice');
    const client = await h.connectAs(account);

    const error = waitForEvent<{ code: string }>(client, 'error');
    client.emit('user:upgrade-credentials', { ...upgradePayload(TEST_PASSWORD), newAuthSalt: 'not-a-salt' });

    expect(await error).toMatchObject({ code: 'validation.invalidPayload' });
    expect((await h.userRepository.findById(account.user.id))?.authVersion).toBe(1);
  });
});

describe('v2 account socket flows', () => {
  async function upgradedAccount(h: Harness) {
    const account = await h.createAccount('Alice');
    const payload = upgradePayload(TEST_PASSWORD);
    await h.userService.upgradeCredentials(account.user.id, payload);
    return { ...account, authKey: payload.newAuthKey };
  }

  it('changes the password with v2 fields and returns no recovery file', async () => {
    const h = await start();
    const account = await upgradedAccount(h);
    const client = await h.connectAs(account);

    const changed = waitForEvent<{ recoveryFile: string | null; recoveryToken: string | null }>(client, 'user:password-changed');
    client.emit('user:change-password', {
      currentPassword: account.authKey,
      newPassword: clientSecret(),
      newAuthSalt: authSalt(),
      encryptedPrivateKeyByPassword: 'new-wrapped-by-password',
    });

    expect(await changed).toEqual({ recoveryFile: null, recoveryToken: null });
    expect((await h.userRepository.findById(account.user.id))?.e2eEncryptedPrivateKeyByPassword).toBe('new-wrapped-by-password');
  });

  it('regenerates the recovery verifier without a server file', async () => {
    const h = await start();
    const account = await upgradedAccount(h);
    const client = await h.connectAs(account);

    const regenerated = waitForEvent<{ recoveryFile: string | null }>(client, 'user:recovery-file-regenerated');
    client.emit('user:regenerate-recovery-file', {
      currentPassword: account.authKey,
      recoveryVerifier: clientSecret(),
      encryptedPrivateKeyByRecovery: 'new-wrapped-by-recovery',
    });

    expect(await regenerated).toEqual({ recoveryFile: null, recoveryToken: null });
  });

  it('changes the nickname without a recovery file and still disconnects other sessions', async () => {
    const h = await start();
    const account = await upgradedAccount(h);
    const client = await h.connectAs(account);
    const other = await h.userService.login('Alice', account.authKey);
    const otherClient = await h.connectAs({ user: account.user, sessionToken: other?.sessionToken ?? '' });

    const revoked = waitForEvent(otherClient, 'user:session-revoked');
    const updated = waitForEvent<{ recoveryFile: string | null; recoveryToken: string | null }>(client, 'user:profile-updated-success');
    client.emit('user:update-profile', { nickname: 'Alicia', avatar: 0, currentPassword: account.authKey });

    expect(await updated).toMatchObject({ recoveryFile: null, recoveryToken: null });
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

  it('reports version 1 in e2e:my-keys for legacy accounts', async () => {
    const h = await start();
    const account = await h.createAccount('Bob');
    const client = await h.connectAs(account);

    const keys = waitForEvent<{ authVersion: number }>(client, 'e2e:my-keys');
    client.emit('e2e:get-my-keys');

    expect(await keys).toMatchObject({ authVersion: 1 });
  });
});

describe('socket docs for v2 credentials', () => {
  it('documents the upgrade events and the new optional fields', () => {
    const events = listSocketEvents();
    const upgrade = events.find((event) => event.event === 'user:upgrade-credentials' && event.direction === 'client-to-server');
    const upgraded = events.find((event) => event.event === 'user:credentials-upgraded' && event.direction === 'server-to-client');
    const change = events.find((event) => event.event === 'user:change-password' && event.direction === 'client-to-server');

    expect(upgrade?.payloadSchema).toMatchObject({
      required: expect.arrayContaining(['currentPassword', 'newAuthSalt', 'newAuthKey', 'recoveryVerifier']) as unknown,
    });
    expect(upgraded).toBeDefined();
    expect(change?.payloadSchema).toMatchObject({
      properties: { newAuthSalt: {}, encryptedPrivateKeyByPassword: {}, recoveryVerifier: {}, encryptedPrivateKeyByRecovery: {} },
    });
  });
});
