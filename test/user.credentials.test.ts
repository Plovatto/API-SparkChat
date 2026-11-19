import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, hashToken, UserService } from '@/modules/users/index.js';
import { buildRoomService } from './support/build-room-service.js';

const PLAINTEXT_PASSWORD = 'correct-horse-battery-staple';

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

describe('UserService v2 registration', () => {
  it('stores the auth key hash, the salt and the recovery verifier hash without a server recovery file', async () => {
    const { userService, userRepository } = await buildRoomService();
    const result = await registerV2(userService);
    const { user, authKey, authSalt: salt, recoveryVerifier } = result;

    expect(result).not.toHaveProperty('recoveryFile');
    expect(result).not.toHaveProperty('recoveryToken');
    const stored = await userRepository.findById(user.id);
    expect(stored?.authVersion).toBe(2);
    expect(stored?.authSalt).toBe(salt);
    expect(stored?.recoveryTokenHash).toBe(hashToken(recoveryVerifier));
    expect(await userService.login('Alice', authKey)).not.toBeNull();
  });

  it('rejects a plaintext password registration without v2 fields', async () => {
    const { userService, userRepository } = await buildRoomService();

    await expect(
      userService.registerAccount({ nickname: 'Bob', avatar: 0, password: PLAINTEXT_PASSWORD } as never),
    ).rejects.toMatchObject({ code: 'user.credentialsIncomplete' });
    expect(await userRepository.findByNickname('bob')).toBeNull();
  });

  it('rejects a salt without a recovery verifier and the reverse', async () => {
    const { userService } = await buildRoomService();

    await expect(
      userService.registerAccount({ nickname: 'Alice', avatar: 0, password: clientSecret(), authSalt: authSalt() } as never),
    ).rejects.toMatchObject({ code: 'user.credentialsIncomplete' });
    await expect(
      userService.registerAccount({ nickname: 'Alice', avatar: 0, password: clientSecret(), recoveryVerifier: clientSecret() } as never),
    ).rejects.toMatchObject({ code: 'user.credentialsIncomplete' });
  });

  it('rejects a v2 registration whose auth key is not a derived key', async () => {
    const { userService } = await buildRoomService();

    await expect(
      userService.registerAccount({ nickname: 'Alice', avatar: 0, password: PLAINTEXT_PASSWORD, authSalt: authSalt(), recoveryVerifier: clientSecret() }),
    ).rejects.toMatchObject({ code: 'user.credentialsInvalid' });
    await expect(
      userService.registerAccount({ nickname: 'Alice', avatar: 0, password: clientSecret(), authSalt: 'short', recoveryVerifier: clientSecret() }),
    ).rejects.toMatchObject({ code: 'user.credentialsInvalid' });
  });
});

describe('UserService.getAuthParams', () => {
  it('returns the stored salt and never version 1, even when the row still says version 1', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user: bob, authSalt: bobSalt } = await registerV2(userService, 'Bob');
    const { authSalt: salt } = await registerV2(userService, 'Alice');
    await userRepository.update(bob.id, { authVersion: 1 });

    expect(await userService.getAuthParams('Bob')).toEqual({ version: 2, salt: bobSalt });
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

});

describe('UserService.login with legacy passwords', () => {
  it('rejects a plaintext password even when its hash is the stored one', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user } = await registerV2(userService);
    await userRepository.update(user.id, { passwordHash: await hashPassword(PLAINTEXT_PASSWORD) });

    expect(await userService.login('Alice', PLAINTEXT_PASSWORD)).toBeNull();
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

    expect(result).not.toHaveProperty('recoveryFile');
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
      userService.changePassword(user.id, { currentPassword: authKey, newPassword: clientSecret(), sessionId } as never),
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

  it('rejects a plaintext current password even when its hash is the stored one', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user, sessionId } = await registerV2(userService);
    await userRepository.update(user.id, { passwordHash: await hashPassword(PLAINTEXT_PASSWORD) });

    await expect(
      userService.changePassword(user.id, {
        currentPassword: PLAINTEXT_PASSWORD,
        newPassword: clientSecret(),
        newAuthSalt: authSalt(),
        encryptedPrivateKeyByPassword: 'wrapped',
        sessionId,
      }),
    ).rejects.toMatchObject({ code: 'user.currentPasswordIncorrect' });
  });

  it('changes the password through the recovery session grant', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user, recoveryVerifier } = await registerV2(userService);
    const recoveryLogin = await userService.loginWithRecovery(user.id, recoveryVerifier);
    if (!recoveryLogin) {
      throw new Error('recovery login failed');
    }
    const newAuthKey = clientSecret();

    await userService.changePassword(user.id, {
      newPassword: newAuthKey,
      newAuthSalt: authSalt(),
      encryptedPrivateKeyByPassword: 'wrapped-by-password',
      sessionId: recoveryLogin.sessionId,
    });

    expect((await userRepository.findById(user.id))?.e2eEncryptedPrivateKeyByPassword).toBe('wrapped-by-password');
    expect(await userService.login('Alice', newAuthKey)).not.toBeNull();
  });
});

describe('removed legacy credential upgrade', () => {
  it('no longer exposes upgradeCredentials', async () => {
    const { userService } = await buildRoomService();

    expect('upgradeCredentials' in userService).toBe(false);
    expect('loginWithKeyfile' in userService).toBe(false);
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

    expect(result).not.toHaveProperty('recoveryFile');
    expect(await userRepository.findById(user.id)).toMatchObject({
      recoveryTokenHash: hashToken(verifier),
      e2eEncryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
    });
  });

  it('requires the recovery pair from a v2 account', async () => {
    const { userService } = await buildRoomService();
    const { user, sessionId, authKey } = await registerV2(userService);

    await expect(userService.regenerateRecoveryFile(user.id, authKey, sessionId, {})).rejects.toMatchObject({
      code: 'user.credentialsIncomplete',
    });
  });

});

describe('UserService.updateProfile nickname change with v2 credentials', () => {
  it('keeps the recovery verifier and returns no server file', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user, sessionId, authKey, recoveryVerifier } = await registerV2(userService);

    const result = await userService.updateProfile(user.id, { nickname: 'Alicia', avatar: 1, currentPassword: authKey }, sessionId);

    expect(result).toEqual({ user: expect.objectContaining({ nickname: 'Alicia' }) as unknown, revokedOtherSessions: true });
    expect((await userRepository.findById(user.id))?.recoveryTokenHash).toBe(hashToken(recoveryVerifier));
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

  it('locks the keys even when the row still says version 1', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user } = await registerV2(userService);
    await userRepository.update(user.id, { authVersion: 1 });

    await userService.publishE2eKeys(user.id, { publicKey: 'public-key', encryptedPrivateKeyByPassword: 'wrapped' });
    await expect(userService.publishE2eKeys(user.id, { publicKey: 'new-public-key' })).rejects.toMatchObject({ code: 'e2e.keysLocked' });

    expect(await userRepository.findById(user.id)).toMatchObject({
      e2ePublicKey: 'public-key',
      e2eEncryptedPrivateKeyByPassword: 'wrapped',
    });
  });
});
