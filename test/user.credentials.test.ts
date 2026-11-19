import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashToken, UserService } from '@/modules/users/index.js';
import { buildRoomService } from './support/build-room-service.js';

const PASSWORD = 'correct-horse-battery-staple';

type Services = Awaited<ReturnType<typeof buildRoomService>>;

function clientSecret(): string {
  return randomBytes(32).toString('base64url');
}

function authSalt(): string {
  return randomBytes(16).toString('base64url');
}

async function registerV2(userService: Services['userService'], nickname = 'Alice') {
  const credentials = { authKey: clientSecret(), authSalt: authSalt(), recoveryVerifier: clientSecret() };
  const result = await userService.registerAccount({
    nickname,
    avatar: 0,
    password: credentials.authKey,
    authSalt: credentials.authSalt,
    recoveryVerifier: credentials.recoveryVerifier,
  });
  return { ...result, ...credentials };
}

async function registerV1(userService: Services['userService'], nickname = 'Bob') {
  return userService.registerAccount({ nickname, avatar: 0, password: PASSWORD });
}

describe('UserService v2 registration', () => {
  it('stores the auth key hash, the salt and the recovery verifier hash without a server recovery file', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user, recoveryFile, recoveryToken, authKey, authSalt: salt, recoveryVerifier } = await registerV2(userService);

    expect(recoveryFile).toBeNull();
    expect(recoveryToken).toBeNull();
    const stored = await userRepository.findById(user.id);
    expect(stored?.authVersion).toBe(2);
    expect(stored?.authSalt).toBe(salt);
    expect(stored?.recoveryTokenHash).toBe(hashToken(recoveryVerifier));
    expect(await userService.login('Alice', authKey)).not.toBeNull();
  });

  it('keeps the legacy registration with a server recovery file', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user, recoveryFile, recoveryToken } = await registerV1(userService);

    expect(recoveryFile?.length).toBeGreaterThan(0);
    expect(recoveryToken).toBeTruthy();
    const stored = await userRepository.findById(user.id);
    expect(stored?.authVersion).toBe(1);
    expect(stored?.authSalt).toBeNull();
  });

  it('rejects a salt without a recovery verifier and the reverse', async () => {
    const { userService } = await buildRoomService();

    await expect(
      userService.registerAccount({ nickname: 'Alice', avatar: 0, password: clientSecret(), authSalt: authSalt() }),
    ).rejects.toMatchObject({ code: 'user.credentialsIncomplete' });
    await expect(
      userService.registerAccount({ nickname: 'Alice', avatar: 0, password: clientSecret(), recoveryVerifier: clientSecret() }),
    ).rejects.toMatchObject({ code: 'user.credentialsIncomplete' });
  });

  it('rejects a v2 registration whose auth key is not a derived key', async () => {
    const { userService } = await buildRoomService();

    await expect(
      userService.registerAccount({ nickname: 'Alice', avatar: 0, password: PASSWORD, authSalt: authSalt(), recoveryVerifier: clientSecret() }),
    ).rejects.toMatchObject({ code: 'user.credentialsInvalid' });
    await expect(
      userService.registerAccount({ nickname: 'Alice', avatar: 0, password: clientSecret(), authSalt: 'short', recoveryVerifier: clientSecret() }),
    ).rejects.toMatchObject({ code: 'user.credentialsInvalid' });
  });
});

describe('UserService.getAuthParams', () => {
  it('returns version 1 for legacy accounts and the stored salt for v2 accounts', async () => {
    const { userService } = await buildRoomService();
    await registerV1(userService, 'Bob');
    const { authSalt: salt } = await registerV2(userService, 'Alice');

    expect(await userService.getAuthParams('Bob')).toEqual({ version: 1 });
    expect(await userService.getAuthParams(' ALICE ')).toEqual({ version: 2, salt });
  });

  it('returns a deterministic fake salt for unknown nicknames', async () => {
    const { userService, userRepository, userSessionRepository } = await buildRoomService();
    const first = await userService.getAuthParams('Ghost');
    const second = await userService.getAuthParams('ghost');
    const other = await userService.getAuthParams('Phantom');
    const otherServer = new UserService(userRepository, userSessionRepository, 'another-recovery-file-secret-0123456789');

    expect(first).toEqual(second);
    expect(first).toMatchObject({ version: 2, salt: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) as unknown });
    expect(other).not.toEqual(first);
    expect(await otherServer.getAuthParams('Ghost')).not.toEqual(first);
  });

  it('hides the assistant account behind a fake salt', async () => {
    const { userService } = await buildRoomService();

    expect(await userService.getAuthParams('SparkAI')).toMatchObject({ version: 2 });
  });
});

describe('UserService.loginWithRecovery', () => {
  it('creates a keyfile session when the recovery key matches', async () => {
    const { userService } = await buildRoomService();
    const { user, recoveryVerifier } = await registerV2(userService);

    const result = await userService.loginWithRecovery(user.id, recoveryVerifier);
    const resumed = await userService.resumeSession(user.id, result?.sessionToken ?? '');

    expect(result?.user.id).toBe(user.id);
    expect(resumed?.authMethod).toBe('keyfile');
  });

  it('rejects a wrong key, a malformed key and an unknown user', async () => {
    const { userService } = await buildRoomService();
    const { user, recoveryVerifier } = await registerV2(userService);

    expect(await userService.loginWithRecovery(user.id, clientSecret())).toBeNull();
    expect(await userService.loginWithRecovery(user.id, `${recoveryVerifier}x`)).toBeNull();
    expect(await userService.loginWithRecovery('missing-user', recoveryVerifier)).toBeNull();
  });

  it('never accepts the legacy recovery token', async () => {
    const { userService } = await buildRoomService();
    const { user, recoveryToken } = await registerV1(userService);

    expect(await userService.loginWithRecovery(user.id, recoveryToken ?? '')).toBeNull();
  });
});

describe('UserService.changePassword with v2 credentials', () => {
  it('updates hash, salt and password wrap of a v2 account without touching the recovery verifier', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user, sessionId, authKey, recoveryVerifier } = await registerV2(userService);
    const newAuthKey = clientSecret();
    const newAuthSalt = authSalt();

    const result = await userService.changePassword(user.id, {
      currentPassword: authKey,
      newPassword: newAuthKey,
      newAuthSalt,
      encryptedPrivateKeyByPassword: 'wrapped-by-password',
      sessionId,
    });

    expect(result.recoveryFile).toBeNull();
    expect(result.recoveryToken).toBeNull();
    const stored = await userRepository.findById(user.id);
    expect(stored?.authSalt).toBe(newAuthSalt);
    expect(stored?.e2eEncryptedPrivateKeyByPassword).toBe('wrapped-by-password');
    expect(stored?.recoveryTokenHash).toBe(hashToken(recoveryVerifier));
    expect(await userService.login('Alice', newAuthKey)).not.toBeNull();
    expect(await userService.login('Alice', authKey)).toBeNull();
  });

  it('replaces the recovery verifier and wrap when the pair is sent', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user, sessionId, authKey } = await registerV2(userService);
    const newVerifier = clientSecret();

    await userService.changePassword(user.id, {
      currentPassword: authKey,
      newPassword: clientSecret(),
      newAuthSalt: authSalt(),
      encryptedPrivateKeyByPassword: 'wrapped-by-password',
      recoveryVerifier: newVerifier,
      encryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
      sessionId,
    });

    const stored = await userRepository.findById(user.id);
    expect(stored?.recoveryTokenHash).toBe(hashToken(newVerifier));
    expect(stored?.e2eEncryptedPrivateKeyByRecovery).toBe('wrapped-by-recovery');
  });

  it('requires the v2 fields from a v2 account', async () => {
    const { userService } = await buildRoomService();
    const { user, sessionId, authKey } = await registerV2(userService);

    await expect(
      userService.changePassword(user.id, { currentPassword: authKey, newPassword: clientSecret(), sessionId }),
    ).rejects.toMatchObject({ code: 'user.credentialsIncomplete' });
    await expect(
      userService.changePassword(user.id, {
        currentPassword: authKey,
        newPassword: 'a-plaintext-password',
        newAuthSalt: authSalt(),
        encryptedPrivateKeyByPassword: 'wrapped',
        sessionId,
      }),
    ).rejects.toMatchObject({ code: 'user.credentialsInvalid' });
  });

  it('rejects a wrong current auth key', async () => {
    const { userService } = await buildRoomService();
    const { user, sessionId } = await registerV2(userService);

    await expect(
      userService.changePassword(user.id, {
        currentPassword: clientSecret(),
        newPassword: clientSecret(),
        newAuthSalt: authSalt(),
        encryptedPrivateKeyByPassword: 'wrapped',
        sessionId,
      }),
    ).rejects.toMatchObject({ code: 'user.currentPasswordIncorrect' });
  });

  it('upgrades a legacy account when v2 fields come with the recovery pair', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user, sessionId } = await registerV1(userService);
    const newAuthKey = clientSecret();
    const newAuthSalt = authSalt();
    const verifier = clientSecret();

    const result = await userService.changePassword(user.id, {
      currentPassword: PASSWORD,
      newPassword: newAuthKey,
      newAuthSalt,
      encryptedPrivateKeyByPassword: 'wrapped-by-password',
      recoveryVerifier: verifier,
      encryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
      sessionId,
    });

    expect(result.recoveryFile).toBeNull();
    const stored = await userRepository.findById(user.id);
    expect(stored).toMatchObject({
      authVersion: 2,
      authSalt: newAuthSalt,
      recoveryTokenHash: hashToken(verifier),
      e2eEncryptedPrivateKeyByPassword: 'wrapped-by-password',
      e2eEncryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
    });
    expect(await userService.login('Bob', newAuthKey)).not.toBeNull();
  });

  it('refuses to upgrade a legacy account without the recovery pair', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user, sessionId } = await registerV1(userService);

    await expect(
      userService.changePassword(user.id, {
        currentPassword: PASSWORD,
        newPassword: clientSecret(),
        newAuthSalt: authSalt(),
        encryptedPrivateKeyByPassword: 'wrapped-by-password',
        sessionId,
      }),
    ).rejects.toMatchObject({ code: 'user.credentialsIncomplete' });
    expect((await userRepository.findById(user.id))?.authVersion).toBe(1);
  });

  it('upgrades a legacy account through the keyfile grant', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user, recoveryFile } = await registerV1(userService);
    const keyfileLogin = await userService.loginWithKeyfile(recoveryFile ?? Buffer.alloc(0));
    if (!keyfileLogin) {
      throw new Error('keyfile login failed');
    }

    await userService.changePassword(user.id, {
      newPassword: clientSecret(),
      newAuthSalt: authSalt(),
      encryptedPrivateKeyByPassword: 'wrapped-by-password',
      recoveryVerifier: clientSecret(),
      encryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
      sessionId: keyfileLogin.sessionId,
    });

    expect((await userRepository.findById(user.id))?.authVersion).toBe(2);
  });
});

describe('UserService.upgradeCredentials', () => {
  function upgradeInput(currentPassword: string) {
    return {
      currentPassword,
      newAuthSalt: authSalt(),
      newAuthKey: clientSecret(),
      encryptedPrivateKeyByPassword: 'wrapped-by-password',
      recoveryVerifier: clientSecret(),
      encryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
    };
  }

  it('moves a legacy account to v2 in one update and keeps its sessions', async () => {
    const { userService, userRepository, userSessionRepository } = await buildRoomService();
    const { user } = await registerV1(userService);
    const input = upgradeInput(PASSWORD);
    const before = await userSessionRepository.listByUser(user.id);

    const updated = await userService.upgradeCredentials(user.id, input);

    expect(updated).toMatchObject({
      authVersion: 2,
      authSalt: input.newAuthSalt,
      recoveryTokenHash: hashToken(input.recoveryVerifier),
      e2eEncryptedPrivateKeyByPassword: 'wrapped-by-password',
      e2eEncryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
    });
    expect(await userRepository.findById(user.id)).toMatchObject({ authVersion: 2, authSalt: input.newAuthSalt });
    expect(await userSessionRepository.listByUser(user.id)).toHaveLength(before.length);
    expect(await userService.login('Bob', input.newAuthKey)).not.toBeNull();
    expect(await userService.login('Bob', PASSWORD)).toBeNull();
    expect(await userService.loginWithRecovery(user.id, input.recoveryVerifier)).not.toBeNull();
  });

  it('lets only one of two concurrent upgrades win', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user } = await registerV1(userService);
    const first = upgradeInput(PASSWORD);
    const second = upgradeInput(PASSWORD);

    const results = await Promise.allSettled([
      userService.upgradeCredentials(user.id, first),
      userService.upgradeCredentials(user.id, second),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'user.credentialsAlreadyUpgraded' });
    expect((await userRepository.findById(user.id))?.authVersion).toBe(2);
  });

  it('rejects a wrong current password and leaves the account on v1', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user } = await registerV1(userService);

    await expect(userService.upgradeCredentials(user.id, upgradeInput('wrong-password-123'))).rejects.toMatchObject({
      code: 'user.currentPasswordIncorrect',
    });
    expect((await userRepository.findById(user.id))?.authVersion).toBe(1);
  });

  it('rejects accounts that already use v2', async () => {
    const { userService } = await buildRoomService();
    const { user, authKey } = await registerV2(userService);

    await expect(userService.upgradeCredentials(user.id, upgradeInput(authKey))).rejects.toMatchObject({
      code: 'user.credentialsAlreadyUpgraded',
    });
  });

  it('rejects malformed derived values', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerV1(userService);

    await expect(userService.upgradeCredentials(user.id, { ...upgradeInput(PASSWORD), newAuthKey: PASSWORD })).rejects.toMatchObject({
      code: 'user.credentialsInvalid',
    });
  });
});

describe('UserService.regenerateRecoveryFile with v2 credentials', () => {
  it('replaces the verifier and the recovery wrap without a server file', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user, sessionId, authKey } = await registerV2(userService);
    const verifier = clientSecret();

    const result = await userService.regenerateRecoveryFile(user.id, authKey, sessionId, {
      recoveryVerifier: verifier,
      encryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
    });

    expect(result.recoveryFile).toBeNull();
    expect(result.recoveryToken).toBeNull();
    expect(await userRepository.findById(user.id)).toMatchObject({
      recoveryTokenHash: hashToken(verifier),
      e2eEncryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
    });
  });

  it('requires the recovery pair from a v2 account', async () => {
    const { userService } = await buildRoomService();
    const { user, sessionId, authKey } = await registerV2(userService);

    await expect(userService.regenerateRecoveryFile(user.id, authKey, sessionId)).rejects.toMatchObject({
      code: 'user.credentialsIncomplete',
    });
  });

  it('keeps the legacy server file for v1 accounts', async () => {
    const { userService } = await buildRoomService();
    const { user, sessionId } = await registerV1(userService);

    const result = await userService.regenerateRecoveryFile(user.id, PASSWORD, sessionId);

    expect(result.recoveryFile?.length).toBeGreaterThan(0);
    expect(result.recoveryToken).toBeTruthy();
  });
});

describe('UserService.updateProfile nickname change with v2 credentials', () => {
  it('keeps the recovery verifier and returns no server file', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user, sessionId, authKey, recoveryVerifier } = await registerV2(userService);

    const result = await userService.updateProfile(user.id, { nickname: 'Alicia', avatar: 1, currentPassword: authKey }, sessionId);

    expect(result).toMatchObject({ recoveryFile: null, recoveryToken: null, revokedOtherSessions: true });
    expect((await userRepository.findById(user.id))?.recoveryTokenHash).toBe(hashToken(recoveryVerifier));
  });

  it('still regenerates the recovery file for v1 accounts', async () => {
    const { userService } = await buildRoomService();
    const { user, sessionId } = await registerV1(userService);

    const result = await userService.updateProfile(user.id, { nickname: 'Bobby', avatar: 1, currentPassword: PASSWORD }, sessionId);

    expect(result?.recoveryFile?.length).toBeGreaterThan(0);
    expect(result?.recoveryToken).toBeTruthy();
  });
});

describe('UserService.publishE2eKeys lock for v2 accounts', () => {
  it('accepts the first identity setup and rejects later replacements', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user } = await registerV2(userService);

    await userService.publishE2eKeys(user.id, {
      publicKey: 'public-key',
      encryptedPrivateKeyByPassword: 'wrapped-by-password',
      encryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
    });

    await expect(userService.publishE2eKeys(user.id, { publicKey: 'other-public-key' })).rejects.toMatchObject({ code: 'e2e.keysLocked' });
    await expect(userService.publishE2eKeys(user.id, { encryptedPrivateKeyByPassword: 'other' })).rejects.toMatchObject({
      code: 'e2e.keysLocked',
    });
    await expect(userService.publishE2eKeys(user.id, { encryptedPrivateKeyByRecovery: 'other' })).rejects.toMatchObject({
      code: 'e2e.keysLocked',
    });
    expect(await userRepository.findById(user.id)).toMatchObject({
      e2ePublicKey: 'public-key',
      e2eEncryptedPrivateKeyByPassword: 'wrapped-by-password',
      e2eEncryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
    });
  });

  it('fills only the empty columns of a v2 account', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user } = await registerV2(userService);

    await userService.publishE2eKeys(user.id, { publicKey: 'public-key' });
    await userService.publishE2eKeys(user.id, { encryptedPrivateKeyByPassword: 'wrapped-by-password' });

    expect(await userRepository.findById(user.id)).toMatchObject({
      e2ePublicKey: 'public-key',
      e2eEncryptedPrivateKeyByPassword: 'wrapped-by-password',
    });
  });

  it('keeps replacing keys for v1 accounts', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user } = await registerV1(userService);

    await userService.publishE2eKeys(user.id, { publicKey: 'public-key', encryptedPrivateKeyByPassword: 'wrapped' });
    await userService.publishE2eKeys(user.id, { publicKey: 'new-public-key', encryptedPrivateKeyByPassword: 'new-wrapped' });

    expect(await userRepository.findById(user.id)).toMatchObject({
      e2ePublicKey: 'new-public-key',
      e2eEncryptedPrivateKeyByPassword: 'new-wrapped',
    });
  });
});
