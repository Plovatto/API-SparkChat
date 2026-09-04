import { describe, expect, it } from 'vitest';
import { hashToken } from '@/modules/users/index.js';
import { buildRoomService } from './support/build-room-service.js';

const PASSWORD = 'correct-horse-battery-staple';

async function registerAlice(userService: Awaited<ReturnType<typeof buildRoomService>>['userService']) {
  return userService.registerAccount({ nickname: 'Alice', avatar: 0, password: PASSWORD, socketId: 'socket-alice' });
}

describe('UserService.registerAccount', () => {
  it('creates a user with a session token and a recovery file', async () => {
    const { userService } = await buildRoomService();

    const { user, sessionToken, recoveryFile, recoveryToken } = await registerAlice(userService);

    expect(user.nickname).toBe('Alice');
    expect(user.nicknameNormalized).toBe('alice');
    expect(sessionToken).toBeTruthy();
    expect(recoveryFile.length).toBeGreaterThan(0);
    expect(recoveryToken).toBeTruthy();
  });

  it('rejects a nickname that is already taken, regardless of case', async () => {
    const { userService } = await buildRoomService();
    await registerAlice(userService);

    await expect(
      userService.registerAccount({ nickname: 'ALICE', avatar: 1, password: PASSWORD, socketId: 'socket-2' }),
    ).rejects.toThrow('Esse nickname já está em uso.');
  });

  it('rejects a password shorter than the minimum length', async () => {
    const { userService } = await buildRoomService();

    await expect(
      userService.registerAccount({ nickname: 'Bob', avatar: 0, password: 'short', socketId: 'socket-bob' }),
    ).rejects.toThrow();
  });

  it('rejects a nickname with special characters', async () => {
    const { userService } = await buildRoomService();

    await expect(
      userService.registerAccount({ nickname: 'Bob!', avatar: 0, password: PASSWORD, socketId: 'socket-bob' }),
    ).rejects.toThrow();
  });

  it('rejects a nickname with fewer than two letters', async () => {
    const { userService } = await buildRoomService();

    await expect(
      userService.registerAccount({ nickname: 'B1', avatar: 0, password: PASSWORD, socketId: 'socket-bob' }),
    ).rejects.toThrow();
  });

  it('accepts a nickname made only of letters and numbers with at least two letters', async () => {
    const { userService } = await buildRoomService();

    const { user } = await userService.registerAccount({
      nickname: 'Bob123',
      avatar: 0,
      password: PASSWORD,
      socketId: 'socket-bob',
    });

    expect(user.nickname).toBe('Bob123');
  });
});

describe('UserService.login', () => {
  it('logs in with the correct password and issues a new session', async () => {
    const { userService } = await buildRoomService();
    await registerAlice(userService);

    const result = await userService.login('Alice', PASSWORD);

    expect(result?.user.nickname).toBe('Alice');
    expect(result?.sessionToken).toBeTruthy();
  });

  it('rejects an incorrect password', async () => {
    const { userService } = await buildRoomService();
    await registerAlice(userService);

    const result = await userService.login('Alice', 'wrong-password');

    expect(result).toBeNull();
  });

  it('rejects a nickname that does not exist', async () => {
    const { userService } = await buildRoomService();

    const result = await userService.login('Ghost', PASSWORD);

    expect(result).toBeNull();
  });

  it('allows two devices to have valid sessions at the same time', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const deviceA = await userService.login('Alice', PASSWORD);
    const deviceB = await userService.login('Alice', PASSWORD);

    const resumedA = await userService.resumeSession(user.id, deviceA?.sessionToken ?? '', 'socket-a');
    const resumedB = await userService.resumeSession(user.id, deviceB?.sessionToken ?? '', 'socket-b');

    expect(resumedA?.user.id).toBe(user.id);
    expect(resumedB?.user.id).toBe(user.id);
  });

  it('resolves each device to its own distinct, matching session id', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const deviceA = await userService.login('Alice', PASSWORD);
    const deviceB = await userService.login('Alice', PASSWORD);

    const resumedA = await userService.resumeSession(user.id, deviceA?.sessionToken ?? '', 'socket-a');
    const resumedB = await userService.resumeSession(user.id, deviceB?.sessionToken ?? '', 'socket-b');

    expect(deviceA?.sessionId).toBeTruthy();
    expect(deviceB?.sessionId).toBeTruthy();
    expect(deviceA?.sessionId).not.toBe(deviceB?.sessionId);
    expect(resumedA?.sessionId).toBe(deviceA?.sessionId);
    expect(resumedB?.sessionId).toBe(deviceB?.sessionId);
  });

  it('creates a session with the password auth method', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const result = await userService.login('Alice', PASSWORD);
    const resumed = await userService.resumeSession(user.id, result?.sessionToken ?? '', 'socket-a');

    expect(resumed?.authMethod).toBe('password');
  });
});

describe('UserService.loginWithKeyfile', () => {
  it('logs in with a valid recovery file', async () => {
    const { userService } = await buildRoomService();
    const { user, recoveryFile, recoveryToken: originalRecoveryToken } = await registerAlice(userService);

    const result = await userService.loginWithKeyfile(recoveryFile);

    expect(result?.user.id).toBe(user.id);
    expect(result?.sessionToken).toBeTruthy();
    expect(result?.recoveryToken).toBe(originalRecoveryToken);
  });

  it('rejects a corrupted recovery file', async () => {
    const { userService } = await buildRoomService();
    const { recoveryFile } = await registerAlice(userService);
    recoveryFile[recoveryFile.length - 1] = (recoveryFile[recoveryFile.length - 1] ?? 0) ^ 0xff;

    const result = await userService.loginWithKeyfile(recoveryFile);

    expect(result).toBeNull();
  });

  it('creates a session with the keyfile auth method', async () => {
    const { userService } = await buildRoomService();
    const { user, recoveryFile } = await registerAlice(userService);

    const result = await userService.loginWithKeyfile(recoveryFile);
    const resumed = await userService.resumeSession(user.id, result?.sessionToken ?? '', 'socket-a');

    expect(resumed?.authMethod).toBe('keyfile');
  });
});

describe('UserService.resumeSession', () => {
  it('rejects an unknown session token', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const result = await userService.resumeSession(user.id, 'not-a-real-token', 'socket-new');

    expect(result).toBeNull();
  });

  it('rejects a session older than the inactivity limit', async () => {
    const { userService, userSessionRepository } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const sessionToken = 'a-fixed-token-for-this-test';
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await userSessionRepository.create({
      id: 'stale-session',
      userId: user.id,
      tokenHash: hashToken(sessionToken),
      authMethod: 'password',
      userAgent: '',
      createdAt: eightDaysAgo,
      lastUsedAt: eightDaysAgo,
    });

    const result = await userService.resumeSession(user.id, sessionToken, 'socket-old');
    expect(result).toBeNull();
  });
});

describe('UserService.verifySession', () => {
  it('returns the user for a valid session token without changing socket or status', async () => {
    const { userService } = await buildRoomService();
    const { user, sessionToken } = await registerAlice(userService);

    const result = await userService.verifySession(user.id, sessionToken);

    expect(result?.id).toBe(user.id);
  });

  it('rejects an unknown session token', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const result = await userService.verifySession(user.id, 'not-a-real-token');

    expect(result).toBeNull();
  });

  it('rejects a token that belongs to a different user', async () => {
    const { userService } = await buildRoomService();
    const { sessionToken } = await registerAlice(userService);
    const { user: bob } = await userService.registerAccount({
      nickname: 'Bob',
      avatar: 0,
      password: 'correct-horse-battery-staple',
      socketId: 'socket-bob',
    });

    const result = await userService.verifySession(bob.id, sessionToken);

    expect(result).toBeNull();
  });
});

describe('UserService.changePassword', () => {
  it('rejects when the current password is wrong for a password-authenticated session', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    await expect(
      userService.changePassword(user.id, 'wrong-password', 'new-password-123', 'password'),
    ).rejects.toThrow('Senha atual incorreta.');
  });

  it('rejects when no current password is given for a password-authenticated session', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    await expect(
      userService.changePassword(user.id, undefined, 'new-password-123', 'password'),
    ).rejects.toThrow('Senha atual incorreta.');
  });

  it('rotates the password, revokes every session and issues a new recovery file', async () => {
    const { userService, userSessionRepository } = await buildRoomService();
    const { user } = await registerAlice(userService);
    await userService.login('Alice', PASSWORD);

    const before = await userService.listSessions(user.id);
    expect(before.length).toBeGreaterThan(0);

    const newPassword = 'a-brand-new-password';
    await userService.changePassword(user.id, PASSWORD, newPassword, 'password');

    const after = await userSessionRepository.listByUser(user.id);
    expect(after).toHaveLength(0);

    const oldLogin = await userService.login('Alice', PASSWORD);
    expect(oldLogin).toBeNull();

    const newLogin = await userService.login('Alice', newPassword);
    expect(newLogin).not.toBeNull();
  });

  it('invalidates the old recovery file after a password change', async () => {
    const { userService } = await buildRoomService();
    const { user, recoveryFile: oldRecoveryFile } = await registerAlice(userService);

    await userService.changePassword(user.id, PASSWORD, 'a-brand-new-password', 'password');

    const result = await userService.loginWithKeyfile(oldRecoveryFile);
    expect(result).toBeNull();
  });

  it('allows changing the password without the current one when the session came from a keyfile login', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const newPassword = 'forgotten-password-recovery';
    await userService.changePassword(user.id, undefined, newPassword, 'keyfile');

    const newLogin = await userService.login('Alice', newPassword);
    expect(newLogin).not.toBeNull();
  });

  it('returns a fresh recovery token different from the one issued at registration', async () => {
    const { userService } = await buildRoomService();
    const { user, recoveryToken: originalRecoveryToken } = await registerAlice(userService);

    const { recoveryToken } = await userService.changePassword(user.id, PASSWORD, 'a-brand-new-password', 'password');

    expect(recoveryToken).toBeTruthy();
    expect(recoveryToken).not.toBe(originalRecoveryToken);
  });
});

describe('UserService.regenerateRecoveryFile', () => {
  it('regenerates the recovery file without requiring the current password', async () => {
    const { userService } = await buildRoomService();
    const { user, recoveryFile: oldRecoveryFile } = await registerAlice(userService);

    const { recoveryFile } = await userService.regenerateRecoveryFile(user.id);

    expect(await userService.loginWithKeyfile(oldRecoveryFile)).toBeNull();
    expect(await userService.loginWithKeyfile(recoveryFile)).not.toBeNull();
  });

  it('issues a new recovery file without touching existing sessions', async () => {
    const { userService, userSessionRepository } = await buildRoomService();
    const { user, recoveryFile: oldRecoveryFile } = await registerAlice(userService);
    const before = await userSessionRepository.listByUser(user.id);

    const { recoveryFile } = await userService.regenerateRecoveryFile(user.id);

    const after = await userSessionRepository.listByUser(user.id);
    expect(after).toHaveLength(before.length);
    expect(await userService.loginWithKeyfile(oldRecoveryFile)).toBeNull();
    expect(await userService.loginWithKeyfile(recoveryFile)).not.toBeNull();
  });
});

describe('UserService.listSessions', () => {
  it('excludes sessions older than the inactivity limit', async () => {
    const { userService, userSessionRepository } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await userSessionRepository.create({
      id: 'stale-session',
      userId: user.id,
      tokenHash: hashToken('a-different-fixed-token'),
      authMethod: 'password',
      userAgent: '',
      createdAt: eightDaysAgo,
      lastUsedAt: eightDaysAgo,
    });

    const sessions = await userService.listSessions(user.id);

    expect(sessions.some((session) => session.id === 'stale-session')).toBe(false);
  });
});

describe('UserService.updateProfile', () => {
  it('updates avatar without issuing a new recovery file when the nickname is unchanged', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const result = await userService.updateProfile(user.id, { nickname: 'Alice', avatar: 3 });

    expect(result?.user.avatar).toBe(3);
    expect(result?.recoveryFile).toBeNull();
  });

  it('issues a new recovery file and invalidates the old one when the nickname changes', async () => {
    const { userService } = await buildRoomService();
    const { user, recoveryFile: oldRecoveryFile } = await registerAlice(userService);

    const result = await userService.updateProfile(user.id, { nickname: 'Alicia', avatar: 0 });

    expect(result?.user.nickname).toBe('Alicia');
    expect(result?.recoveryFile).not.toBeNull();
    expect(await userService.loginWithKeyfile(oldRecoveryFile)).toBeNull();
  });

  it('rejects renaming to a nickname already used by someone else', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);
    await userService.registerAccount({ nickname: 'Bob', avatar: 0, password: PASSWORD, socketId: 'socket-bob' });

    await expect(userService.updateProfile(user.id, { nickname: 'Bob', avatar: 0 })).rejects.toThrow(
      'Esse nickname já está em uso.',
    );
  });

  it('allows renaming to the same nickname unchanged', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const result = await userService.updateProfile(user.id, { nickname: 'Alice', avatar: 5 });

    expect(result?.user.nickname).toBe('Alice');
    expect(result?.recoveryFile).toBeNull();
  });

  it('returns null when updating the profile of an unknown user', async () => {
    const { userService } = await buildRoomService();

    const result = await userService.updateProfile('unknown-id', { nickname: 'Ghost', avatar: 0 });

    expect(result).toBeNull();
  });
});

describe('UserService theme', () => {
  it('persists a user theme choice', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const updated = await userService.updateTheme(user.id, { baseTheme: 'light', colorTheme: 'ocean' });

    expect(updated?.theme).toEqual({ baseTheme: 'light', colorTheme: 'ocean' });
    expect((await userService.getUser(user.id))?.theme).toEqual({ baseTheme: 'light', colorTheme: 'ocean' });
  });

  it('returns null when updating the theme of an unknown user', async () => {
    const { userService } = await buildRoomService();

    const updated = await userService.updateTheme('unknown-id', { baseTheme: 'light', colorTheme: 'ocean' });

    expect(updated).toBeNull();
  });
});

describe('UserService.updateStatusText', () => {
  it('sets a trimmed status text', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const updated = await userService.updateStatusText(user.id, '  no trampo  ');

    expect(updated?.statusText).toBe('no trampo');
    expect((await userService.getUser(user.id))?.statusText).toBe('no trampo');
  });

  it('clears the status text when given an empty or whitespace-only string', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);
    await userService.updateStatusText(user.id, 'no trampo');

    const updated = await userService.updateStatusText(user.id, '   ');

    expect(updated?.statusText).toBeNull();
  });

  it('returns null when updating the status text of an unknown user', async () => {
    const { userService } = await buildRoomService();

    const updated = await userService.updateStatusText('unknown-id', 'oi');

    expect(updated).toBeNull();
  });
});

describe('UserService.publishE2eKeys / getPublicKeys', () => {
  it('publishes and stores the public key and both wrapped private key blobs', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    await userService.publishE2eKeys(user.id, {
      publicKey: 'pub-key-alice',
      encryptedPrivateKeyByPassword: 'wrapped-by-password',
      encryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
    });

    const stored = await userService.getUser(user.id);
    expect(stored?.e2ePublicKey).toBe('pub-key-alice');
    expect(stored?.e2eEncryptedPrivateKeyByPassword).toBe('wrapped-by-password');
    expect(stored?.e2eEncryptedPrivateKeyByRecovery).toBe('wrapped-by-recovery');
  });

  it('updates only the fields provided, leaving the others untouched', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    await userService.publishE2eKeys(user.id, {
      publicKey: 'pub-key-alice',
      encryptedPrivateKeyByPassword: 'wrapped-by-password',
      encryptedPrivateKeyByRecovery: 'wrapped-by-recovery',
    });

    await userService.publishE2eKeys(user.id, { encryptedPrivateKeyByRecovery: 'rewrapped-by-recovery' });

    const stored = await userService.getUser(user.id);
    expect(stored?.e2ePublicKey).toBe('pub-key-alice');
    expect(stored?.e2eEncryptedPrivateKeyByPassword).toBe('wrapped-by-password');
    expect(stored?.e2eEncryptedPrivateKeyByRecovery).toBe('rewrapped-by-recovery');
  });

  it('returns only the public keys of users who have published one', async () => {
    const { userService } = await buildRoomService();
    const { user: alice } = await registerAlice(userService);
    const { user: bob } = await userService.registerAccount({
      nickname: 'Bob',
      avatar: 0,
      password: PASSWORD,
      socketId: 'socket-bob',
    });

    await userService.publishE2eKeys(alice.id, { publicKey: 'pub-key-alice' });

    const keys = await userService.getPublicKeys([alice.id, bob.id, 'unknown-id']);

    expect(keys).toEqual([{ userId: alice.id, publicKey: 'pub-key-alice' }]);
  });
});
