import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPasswordPolicy, MIN_PASSWORD_LENGTH } from '@/modules/users/user.credentials.js';
import { startSocketHarness, TEST_PASSWORD, waitForEvent } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

const secret = () => randomBytes(32).toString('base64url');
const salt = () => randomBytes(16).toString('base64url');

function registration(nickname: string, extra: Record<string, unknown> = {}) {
  return { mode: 'register', nickname, avatar: 0, password: secret(), authSalt: salt(), recoveryVerifier: secret(), ...extra };
}

describe('assertPasswordPolicy', () => {
  it('accepts lengths at or above the minimum', () => {
    expect(() => assertPasswordPolicy(MIN_PASSWORD_LENGTH, false)).not.toThrow();
    expect(() => assertPasswordPolicy(MIN_PASSWORD_LENGTH + 40, true)).not.toThrow();
  });

  it('rejects declared lengths below the minimum even when the declaration is optional', () => {
    expect(() => assertPasswordPolicy(MIN_PASSWORD_LENGTH - 1, false)).toThrowError(expect.objectContaining({ code: 'user.passwordTooShort' }));
    expect(() => assertPasswordPolicy(0, false)).toThrowError(expect.objectContaining({ code: 'user.passwordTooShort' }));
  });

  it('tolerates a missing declaration from older clients unless the declaration is required', () => {
    expect(() => assertPasswordPolicy(undefined, false)).not.toThrow();
    expect(() => assertPasswordPolicy(undefined, true)).toThrowError(expect.objectContaining({ code: 'user.passwordLengthRequired' }));
  });
});

describe('password policy over sockets', () => {
  it('rejects a registration that declares a short password with a clear code', async () => {
    harness = await startSocketHarness();
    const client = await harness.connect();

    const failed = waitForEvent<{ mode: string; code: string; params?: { minLength: number } }>(client, 'user:auth-failed');
    client.emit('user:join', registration('Shorty', { passwordLength: 11 }));

    expect(await failed).toMatchObject({ mode: 'register', code: 'user.passwordTooShort', params: { minLength: 12 } });
    expect(await harness.userService.getUserByNickname('Shorty')).toBeNull();
  });

  it('accepts a registration declaring the minimum length', async () => {
    harness = await startSocketHarness();
    const client = await harness.connect();

    const registered = waitForEvent(client, 'user:registered');
    client.emit('user:join', registration('Longer', { passwordLength: 12 }));
    await registered;

    expect(await harness.userService.getUserByNickname('Longer')).not.toBeNull();
  });

  it('keeps accepting registrations from older clients that declare nothing', async () => {
    harness = await startSocketHarness();
    const client = await harness.connect();

    const registered = waitForEvent(client, 'user:registered');
    client.emit('user:join', registration('Oldie'));
    await registered;
  });

  it('rejects a malformed declaration', async () => {
    harness = await startSocketHarness();
    const client = await harness.connect();

    const failed = waitForEvent<{ mode: string }>(client, 'user:auth-failed');
    client.emit('user:join', registration('Weird', { passwordLength: -3 }));

    expect(await failed).toMatchObject({ mode: 'register', reason: 'invalid' });
  });

  it('rejects a password change that declares a short password and leaves the credentials untouched', async () => {
    harness = await startSocketHarness();
    const account = await harness.createAccount('Alice');
    await harness.userRepository.update(account.user.id, {
      e2eEncryptedPrivateKeyByPassword: 'wrapped-by-password',
      e2eEncryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
    });
    const client = await harness.connectAs(account);

    const error = waitForEvent<{ code: string }>(client, 'error');
    client.emit('user:change-password', {
      currentPassword: TEST_PASSWORD,
      newPassword: secret(),
      passwordLength: 8,
      newAuthSalt: salt(),
      encryptedPrivateKeyByPassword: 'new-wrapped',
    });

    expect(await error).toMatchObject({ code: 'user.passwordTooShort' });
    expect((await harness.userRepository.findById(account.user.id))?.e2eEncryptedPrivateKeyByPassword).toBe('wrapped-by-password');
  });

  it('accepts a compliant password change', async () => {
    harness = await startSocketHarness();
    const account = await harness.createAccount('Alice');
    await harness.userRepository.update(account.user.id, {
      e2eEncryptedPrivateKeyByPassword: 'wrapped-by-password',
      e2eEncryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
    });
    const client = await harness.connectAs(account);

    const changed = waitForEvent(client, 'user:password-changed');
    client.emit('user:change-password', {
      currentPassword: TEST_PASSWORD,
      newPassword: secret(),
      passwordLength: 14,
      newAuthSalt: salt(),
      encryptedPrivateKeyByPassword: 'new-wrapped',
    });
    await changed;
  });

  it('still lets an existing account whose password predates the policy log in', async () => {
    harness = await startSocketHarness();
    const account = await harness.createAccount('Legacy');

    const result = await harness.userService.login('Legacy', TEST_PASSWORD);

    expect(result?.user.id).toBe(account.user.id);
  });
});
