import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { hashToken } from '@/modules/users/index.js';
import { buildRoomService } from './support/build-room-service.js';
import { TEST_V2_SIGNUP } from './support/test-constants.js';

const PASSWORD = 'correct-horse-battery-staple-0123456789abcd';
const DAY_MS = 24 * 60 * 60 * 1000;
const scryptAsync = promisify(scrypt);

async function legacyHashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

const NEW_PASSWORD = 'a-brand-new-auth-key-0123456789abcdefghijkl';
const RECOVERY_KEY = TEST_V2_SIGNUP.recoveryVerifier;

function v2Change(newPassword: string) {
  return { newPassword, newAuthSalt: 'bmV3LWF1dGgtc2FsdC0xMj', encryptedPrivateKeyByPassword: 'rewrapped-by-password' };
}

async function registerAlice(userService: Awaited<ReturnType<typeof buildRoomService>>['userService']) {
  return userService.registerAccount({ nickname: 'Alice', avatar: 0, password: PASSWORD, ...TEST_V2_SIGNUP });
}

async function loginWithRecoveryKey(userService: Awaited<ReturnType<typeof buildRoomService>>['userService'], userId: string) {
  const result = await userService.loginWithRecovery(userId, RECOVERY_KEY);
  if (!result) {
    throw new Error('recovery login failed');
  }
  return result;
}

describe('UserService.registerAccount', () => {
  it('creates a v2 user with a session token and no server recovery file', async () => {
    const { userService } = await buildRoomService();

    const result = await registerAlice(userService);

    expect(result.user.nickname).toBe('Alice');
    expect(result.user.nicknameNormalized).toBe('alice');
    expect(result.user.authVersion).toBe(2);
    expect(result.sessionToken).toBeTruthy();
    expect(result).not.toHaveProperty('recoveryFile');
    expect(result).not.toHaveProperty('recoveryToken');
  });

  it('rejects a nickname that is already taken, regardless of case', async () => {
    const { userService } = await buildRoomService();
    await registerAlice(userService);

    await expect(
      userService.registerAccount({ nickname: 'ALICE', avatar: 1, password: PASSWORD, ...TEST_V2_SIGNUP }),
    ).rejects.toMatchObject({ code: 'user.nicknameTaken', message: 'Esse nickname já está em uso.' });
  });

  it('rejects a password that is not a derived auth key', async () => {
    const { userService } = await buildRoomService();

    await expect(
      userService.registerAccount({ nickname: 'Bob', avatar: 0, password: 'short', ...TEST_V2_SIGNUP }),
    ).rejects.toMatchObject({ code: 'user.credentialsInvalid' });
  });

  it('rejects a nickname with special characters', async () => {
    const { userService } = await buildRoomService();

    await expect(
      userService.registerAccount({ nickname: 'Bob!', avatar: 0, password: PASSWORD, ...TEST_V2_SIGNUP }),
    ).rejects.toMatchObject({
      code: 'user.nicknameInvalid',
      message: 'Nickname deve ter entre 2 e 20 caracteres, usando apenas letras e números, com pelo menos 2 letras.',
      params: { minLength: 2, maxLength: 20, minLetters: 2 },
    });
  });

  it('rejects a nickname with fewer than two letters', async () => {
    const { userService } = await buildRoomService();

    await expect(
      userService.registerAccount({ nickname: 'B1', avatar: 0, password: PASSWORD, ...TEST_V2_SIGNUP }),
    ).rejects.toMatchObject({ code: 'user.nicknameInvalid' });
  });

  it('accepts a nickname made only of letters and numbers with at least two letters', async () => {
    const { userService } = await buildRoomService();

    const { user } = await userService.registerAccount({
      nickname: 'Bob123',
      avatar: 0,
      password: PASSWORD, ...TEST_V2_SIGNUP
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

    const resumedA = await userService.resumeSession(user.id, deviceA?.sessionToken ?? '');
    const resumedB = await userService.resumeSession(user.id, deviceB?.sessionToken ?? '');

    expect(resumedA?.user.id).toBe(user.id);
    expect(resumedB?.user.id).toBe(user.id);
  });

  it('resolves each device to its own distinct, matching session id', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const deviceA = await userService.login('Alice', PASSWORD);
    const deviceB = await userService.login('Alice', PASSWORD);

    const resumedA = await userService.resumeSession(user.id, deviceA?.sessionToken ?? '');
    const resumedB = await userService.resumeSession(user.id, deviceB?.sessionToken ?? '');

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
    const resumed = await userService.resumeSession(user.id, result?.sessionToken ?? '');

    expect(resumed?.authMethod).toBe('password');
  });
});

describe('UserService.loginWithRecovery sessions', () => {
  it('creates a session with the keyfile auth method', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const result = await loginWithRecoveryKey(userService, user.id);
    const resumed = await userService.resumeSession(user.id, result.sessionToken);

    expect(resumed?.authMethod).toBe('keyfile');
  });
});

describe('UserService.resumeSession', () => {
  it('rejects an unknown session token', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const result = await userService.resumeSession(user.id, 'not-a-real-token');

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

    const result = await userService.resumeSession(user.id, sessionToken);
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
      password: 'correct-horse-battery-staple-0123456789abcd', ...TEST_V2_SIGNUP
    });

    const result = await userService.verifySession(bob.id, sessionToken);

    expect(result).toBeNull();
  });
});

describe('UserService.isSessionActive', () => {
  it('accepts a live session and rejects it once revoked', async () => {
    const { userService } = await buildRoomService();
    const { user, sessionId } = await registerAlice(userService);

    await expect(userService.isSessionActive(user.id, sessionId)).resolves.toBe(true);

    await userService.revokeSession(user.id, sessionId);

    await expect(userService.isSessionActive(user.id, sessionId)).resolves.toBe(false);
  });

  it('rejects a session id that belongs to a different user', async () => {
    const { userService } = await buildRoomService();
    const { sessionId } = await registerAlice(userService);
    const { user: bob } = await userService.registerAccount({ nickname: 'Bob', avatar: 0, password: PASSWORD, ...TEST_V2_SIGNUP });

    await expect(userService.isSessionActive(bob.id, sessionId)).resolves.toBe(false);
  });
});

describe('UserService.isSessionWithinLifetime', () => {
  async function seedSession(createdDaysAgo: number, idleDaysAgo: number) {
    const { userService, userSessionRepository } = await buildRoomService();
    const { user } = await registerAlice(userService);
    await userSessionRepository.create({
      id: 'socket-session',
      userId: user.id,
      tokenHash: hashToken('socket-session-token'),
      authMethod: 'password',
      userAgent: '',
      createdAt: new Date(Date.now() - createdDaysAgo * DAY_MS).toISOString(),
      lastUsedAt: new Date(Date.now() - idleDaysAgo * DAY_MS).toISOString(),
    });
    return { userService, user };
  }

  it('keeps a connected session alive past the idle window', async () => {
    const { userService, user } = await seedSession(10, 9);

    await expect(userService.isSessionWithinLifetime(user.id, 'socket-session')).resolves.toBe(true);
  });

  it('ends a session past its absolute lifetime', async () => {
    const { userService, user } = await seedSession(31, 0);

    await expect(userService.isSessionWithinLifetime(user.id, 'socket-session')).resolves.toBe(false);
  });

  it('ends a session that no longer exists', async () => {
    const { userService, user } = await seedSession(1, 0);
    await userService.revokeSession(user.id, 'socket-session');

    await expect(userService.isSessionWithinLifetime(user.id, 'socket-session')).resolves.toBe(false);
  });
});

describe('UserService session lifetime', () => {
  it('rejects a session created more than 30 days ago even when it was used recently', async () => {
    const { userService, userSessionRepository } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const sessionToken = 'an-old-but-busy-session-token';
    await userSessionRepository.create({
      id: 'old-busy-session',
      userId: user.id,
      tokenHash: hashToken(sessionToken),
      authMethod: 'password',
      userAgent: '',
      createdAt: new Date(Date.now() - 31 * DAY_MS).toISOString(),
      lastUsedAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });

    await expect(userService.resumeSession(user.id, sessionToken)).resolves.toBeNull();
    await expect(userService.verifySession(user.id, sessionToken)).resolves.toBeNull();
    await expect(userService.isSessionActive(user.id, 'old-busy-session')).resolves.toBe(false);
    const sessions = await userService.listSessions(user.id);
    expect(sessions.some((session) => session.id === 'old-busy-session')).toBe(false);
  });

  it('accepts a session created 29 days ago that is still in use', async () => {
    const { userService, userSessionRepository } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const sessionToken = 'a-29-day-old-session-token';
    await userSessionRepository.create({
      id: 'recent-enough-session',
      userId: user.id,
      tokenHash: hashToken(sessionToken),
      authMethod: 'password',
      userAgent: '',
      createdAt: new Date(Date.now() - 29 * DAY_MS).toISOString(),
      lastUsedAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });

    await expect(userService.resumeSession(user.id, sessionToken)).resolves.not.toBeNull();
  });
});

describe('UserService password hashing', () => {
  it('upgrades a legacy password hash after a successful login', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user } = await registerAlice(userService);
    const legacyHash = await legacyHashPassword(PASSWORD);
    await userRepository.update(user.id, { passwordHash: legacyHash });

    const result = await userService.login('Alice', PASSWORD);

    expect(result).not.toBeNull();
    const stored = await userRepository.findById(user.id);
    expect(stored?.passwordHash).not.toBe(legacyHash);
    expect(stored?.passwordHash.startsWith('scrypt$')).toBe(true);
    await expect(userService.login('Alice', PASSWORD)).resolves.not.toBeNull();
  });

  it('keeps the legacy hash when the login fails', async () => {
    const { userService, userRepository } = await buildRoomService();
    const { user } = await registerAlice(userService);
    const legacyHash = await legacyHashPassword(PASSWORD);
    await userRepository.update(user.id, { passwordHash: legacyHash });

    await expect(userService.login('Alice', 'wrong-password-here')).resolves.toBeNull();

    expect((await userRepository.findById(user.id))?.passwordHash).toBe(legacyHash);
  });

  it('rejects a login password longer than the maximum without hashing it', async () => {
    const { userService } = await buildRoomService();
    await registerAlice(userService);

    await expect(userService.login('Alice', 'x'.repeat(1025))).resolves.toBeNull();
  });

  it('rejects registering with a password longer than an auth key', async () => {
    const { userService } = await buildRoomService();

    await expect(userService.registerAccount({ nickname: 'Longpass', avatar: 0, password: 'x'.repeat(1025), ...TEST_V2_SIGNUP })).rejects.toMatchObject({
      code: 'user.credentialsInvalid',
    });
  });
});

describe('UserService.changePassword', () => {
  it('rejects when the current password is wrong for a password-authenticated session', async () => {
    const { userService } = await buildRoomService();
    const { user, sessionId } = await registerAlice(userService);

    await expect(
      userService.changePassword(user.id, { currentPassword: 'wrong-password', ...v2Change(NEW_PASSWORD), sessionId }),
    ).rejects.toMatchObject({ code: 'user.currentPasswordIncorrect', message: 'Senha atual incorreta.' });
  });

  it('requires the current password for a password-authenticated session', async () => {
    const { userService } = await buildRoomService();
    const { user, sessionId } = await registerAlice(userService);

    await expect(userService.changePassword(user.id, { ...v2Change(NEW_PASSWORD), sessionId })).rejects.toMatchObject({
      code: 'user.currentPasswordRequired',
    });
  });

  it('rotates the password and revokes every session', async () => {
    const { userService, userSessionRepository } = await buildRoomService();
    const { user, sessionId } = await registerAlice(userService);
    await userService.login('Alice', PASSWORD);

    const before = await userService.listSessions(user.id);
    expect(before.length).toBeGreaterThan(0);

    const newPassword = NEW_PASSWORD;
    await userService.changePassword(user.id, { currentPassword: PASSWORD, ...v2Change(newPassword), sessionId });

    const after = await userSessionRepository.listByUser(user.id);
    expect(after).toHaveLength(0);

    const oldLogin = await userService.login('Alice', PASSWORD);
    expect(oldLogin).toBeNull();

    const newLogin = await userService.login('Alice', newPassword);
    expect(newLogin).not.toBeNull();
  });

  it('keeps the recovery key valid after a password change without a new recovery pair', async () => {
    const { userService } = await buildRoomService();
    const { user, sessionId } = await registerAlice(userService);

    await userService.changePassword(user.id, { currentPassword: PASSWORD, ...v2Change(NEW_PASSWORD), sessionId });

    expect(await userService.loginWithRecovery(user.id, RECOVERY_KEY)).not.toBeNull();
  });

  it('allows one change without the current password right after a recovery login', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);
    const recoveryLogin = await loginWithRecoveryKey(userService, user.id);

    await userService.changePassword(recoveryLogin.user.id, { ...v2Change(NEW_PASSWORD), sessionId: recoveryLogin.sessionId });

    const newLogin = await userService.login('Alice', NEW_PASSWORD);
    expect(newLogin).not.toBeNull();
  });

  it('allows the password-free change only once for the same keyfile session', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);
    const keyfileLogin = await loginWithRecoveryKey(userService, user.id);
    const input = { ...v2Change(NEW_PASSWORD), sessionId: keyfileLogin.sessionId };

    const results = await Promise.allSettled([
      userService.changePassword(keyfileLogin.user.id, input),
      userService.changePassword(keyfileLogin.user.id, input),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'user.currentPasswordRequired' } });
  });

  it('requires the current password for a keyfile session older than 10 minutes', async () => {
    const { userService, userSessionRepository } = await buildRoomService();
    const { user } = await registerAlice(userService);
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await userSessionRepository.create({
      id: 'old-keyfile-session',
      userId: user.id,
      tokenHash: hashToken('old-keyfile-session-token'),
      authMethod: 'keyfile',
      userAgent: '',
      createdAt: elevenMinutesAgo,
      lastUsedAt: new Date().toISOString(),
    });

    await expect(
      userService.changePassword(user.id, { ...v2Change(NEW_PASSWORD), sessionId: 'old-keyfile-session' }),
    ).rejects.toMatchObject({ code: 'user.currentPasswordRequired' });
    await expect(
      userService.changePassword(user.id, { currentPassword: PASSWORD, ...v2Change(NEW_PASSWORD), sessionId: 'old-keyfile-session' }),
    ).resolves.toMatchObject({ id: user.id, authVersion: 2 });
  });

  it('does not consume the keyfile grant when the new password is invalid', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);
    const keyfileLogin = await loginWithRecoveryKey(userService, user.id);

    await expect(
      userService.changePassword(keyfileLogin.user.id, { ...v2Change('short'), sessionId: keyfileLogin.sessionId }),
    ).rejects.toMatchObject({ code: 'user.credentialsInvalid' });
    await expect(
      userService.changePassword(keyfileLogin.user.id, { ...v2Change(NEW_PASSWORD), sessionId: keyfileLogin.sessionId }),
    ).resolves.toMatchObject({ id: user.id });
  });

});

describe('UserService.regenerateRecoveryFile', () => {
  const NEXT_RECOVERY = { recoveryVerifier: 'next-recovery-verifier-0123456789abcdefghij', encryptedPrivateKeyByRecovery: 'rewrapped-by-recovery' };

  it('requires the current password', async () => {
    const { userService } = await buildRoomService();
    const { user, sessionId } = await registerAlice(userService);

    await expect(userService.regenerateRecoveryFile(user.id, undefined, sessionId, NEXT_RECOVERY)).rejects.toMatchObject({
      code: 'user.currentPasswordIncorrect',
    });
    await expect(userService.regenerateRecoveryFile(user.id, 'wrong-password', sessionId, NEXT_RECOVERY)).rejects.toMatchObject({
      code: 'user.currentPasswordIncorrect',
    });
    expect(await userService.loginWithRecovery(user.id, RECOVERY_KEY)).not.toBeNull();
  });

  it('requires the current password for keyfile sessions too', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);
    const keyfileLogin = await loginWithRecoveryKey(userService, user.id);

    await expect(userService.regenerateRecoveryFile(keyfileLogin.user.id, undefined, keyfileLogin.sessionId, NEXT_RECOVERY)).rejects.toMatchObject({
      code: 'user.currentPasswordIncorrect',
    });
  });

  it('replaces the recovery verifier and revokes every other session', async () => {
    const { userService, userSessionRepository } = await buildRoomService();
    const { user, sessionId } = await registerAlice(userService);
    await loginWithRecoveryKey(userService, user.id);
    await userService.login('Alice', PASSWORD);

    await userService.regenerateRecoveryFile(user.id, PASSWORD, sessionId, NEXT_RECOVERY);

    const after = await userSessionRepository.listByUser(user.id);
    expect(after.map((session) => session.id)).toEqual([sessionId]);
    expect(await userService.loginWithRecovery(user.id, RECOVERY_KEY)).toBeNull();
    expect(await userService.loginWithRecovery(user.id, NEXT_RECOVERY.recoveryVerifier)).not.toBeNull();
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
  it('updates avatar without asking for the password when the nickname is unchanged', async () => {
    const { userService } = await buildRoomService();
    const { user, sessionId } = await registerAlice(userService);

    const result = await userService.updateProfile(user.id, { nickname: 'Alice', avatar: 3 }, sessionId);

    expect(result).toEqual({ user: expect.objectContaining({ avatar: 3 }) as unknown, revokedOtherSessions: false });
  });

  it('requires the current password to change the nickname', async () => {
    const { userService } = await buildRoomService();
    const { user, sessionId } = await registerAlice(userService);

    await expect(userService.updateProfile(user.id, { nickname: 'Alicia', avatar: 0 }, sessionId)).rejects.toMatchObject({
      code: 'user.currentPasswordIncorrect',
    });
    await expect(
      userService.updateProfile(user.id, { nickname: 'Alicia', avatar: 0, currentPassword: 'wrong-password' }, sessionId),
    ).rejects.toMatchObject({ code: 'user.currentPasswordIncorrect' });
    expect((await userService.getUser(user.id))?.nickname).toBe('Alice');
  });

  it('keeps the recovery key and revokes other sessions when the nickname changes', async () => {
    const { userService, userSessionRepository } = await buildRoomService();
    const { user, sessionId } = await registerAlice(userService);
    await userService.login('Alice', PASSWORD);

    const result = await userService.updateProfile(user.id, { nickname: 'Alicia', avatar: 0, currentPassword: PASSWORD }, sessionId);

    expect(result?.user.nickname).toBe('Alicia');
    expect(result).not.toHaveProperty('recoveryFile');
    const remaining = await userSessionRepository.listByUser(user.id);
    expect(remaining.map((session) => session.id).filter((id) => id === sessionId)).toEqual([sessionId]);
    expect(remaining.filter((session) => session.authMethod === 'password')).toHaveLength(1);
    expect(await userService.loginWithRecovery(user.id, RECOVERY_KEY)).not.toBeNull();
  });

  it('rejects renaming to a nickname already used by someone else', async () => {
    const { userService } = await buildRoomService();
    const { user, sessionId } = await registerAlice(userService);
    await userService.registerAccount({ nickname: 'Bob', avatar: 0, password: PASSWORD, ...TEST_V2_SIGNUP });

    await expect(userService.updateProfile(user.id, { nickname: 'Bob', avatar: 0, currentPassword: PASSWORD }, sessionId)).rejects.toMatchObject({
      code: 'user.nicknameTaken',
      message: 'Esse nickname já está em uso.',
    });
  });

  it('allows renaming to the same nickname unchanged', async () => {
    const { userService } = await buildRoomService();
    const { user, sessionId } = await registerAlice(userService);

    const result = await userService.updateProfile(user.id, { nickname: 'Alice', avatar: 5 }, sessionId);

    expect(result?.user.nickname).toBe('Alice');
    expect(result?.revokedOtherSessions).toBe(false);
  });

  it('returns null when updating the profile of an unknown user', async () => {
    const { userService } = await buildRoomService();

    const result = await userService.updateProfile('unknown-id', { nickname: 'Ghost', avatar: 0 }, 'unknown-session');

    expect(result).toBeNull();
  });
});

describe('UserService theme', () => {
  it('gives users who never picked a theme the Violet Night default', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);

    const stored = await userService.getUser(user.id);

    expect(stored && userService.toPublicUser(stored).theme).toEqual({ baseTheme: 'dark', colorTheme: 'duskViolet' });
  });

  it('keeps the theme a user picked instead of the default', async () => {
    const { userService } = await buildRoomService();
    const { user } = await registerAlice(userService);
    await userService.updateTheme(user.id, { baseTheme: 'dark', colorTheme: 'standard' });

    const stored = await userService.getUser(user.id);

    expect(stored && userService.toPublicUser(stored).theme).toEqual({ baseTheme: 'dark', colorTheme: 'standard' });
  });

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
      password: PASSWORD, ...TEST_V2_SIGNUP
    });

    await userService.publishE2eKeys(alice.id, { publicKey: 'pub-key-alice' });

    const keys = await userService.getPublicKeys([alice.id, bob.id, 'unknown-id']);

    expect(keys).toEqual([{ userId: alice.id, publicKey: 'pub-key-alice' }]);
  });
});

describe('UserService.getUsersByIds', () => {
  it('returns every existing user keyed by id and keeps getPublicKeys in request order', async () => {
    const { userService } = await buildRoomService();
    const { user: alice } = await registerAlice(userService);
    const { user: bob } = await userService.registerAccount({ nickname: 'Bob', avatar: 2, password: PASSWORD, ...TEST_V2_SIGNUP });
    await userService.publishE2eKeys(alice.id, { publicKey: 'pub-key-alice' });
    await userService.publishE2eKeys(bob.id, { publicKey: 'pub-key-bob' });

    const usersById = await userService.getUsersByIds([bob.id, alice.id, 'unknown-id', bob.id]);
    expect([...usersById.keys()].sort()).toEqual([alice.id, bob.id].sort());
    expect(usersById.get(bob.id)?.avatar).toBe(2);
    expect((await userService.getUsersByIds([])).size).toBe(0);

    const keys = await userService.getPublicKeys([bob.id, alice.id, bob.id]);
    expect(keys).toEqual([
      { userId: bob.id, publicKey: 'pub-key-bob' },
      { userId: alice.id, publicKey: 'pub-key-alice' },
    ]);
  });
});
