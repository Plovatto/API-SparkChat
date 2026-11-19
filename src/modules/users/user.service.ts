import { randomUUID } from 'node:crypto';
import { logger } from '../../config/logger.js';
import { AppError } from '../../lib/app-error.js';
import {
  ASSISTANT_USER_ID,
  isValidNicknameFormat,
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
  NICKNAME_MIN_LETTERS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type AuthMethod,
  type PublicUser,
  type UserStatus,
  type UserChatSettings,
  type UserTheme,
} from './user.model.js';
import { authVersionOf, deriveFakeSaltKey, fakeAuthSalt, isAuthSalt, isClientSecret } from './user.credentials.js';
import { hashPassword, passwordHashNeedsRehash, verifyPassword } from './user.password.js';
import { verifyIdentityBinding } from './user.signing-key.js';
import { decodeRecoveryFile, encodeRecoveryFile } from './user.recovery-file.js';
import type { UserRepository } from './user.repository.js';
import type { UserSessionRepository } from './user.session.repository.js';
import { constantTimeEqual, generateToken, hashToken } from './user.token.js';
import type { SessionRecord, UserRecord } from './user.types.js';
import type { E2ePublicKeyEntry } from './user.events.js';

export interface RegisterAccountInput {
  nickname: string;
  avatar: number;
  password: string;
  authSalt?: string | undefined;
  recoveryVerifier?: string | undefined;
  userAgent?: string;
}

export interface AuthenticatedResult {
  user: UserRecord;
  sessionToken: string;
  sessionId: string;
}

export interface RegisteredResult extends AuthenticatedResult {
  recoveryFile: Buffer | null;
  recoveryToken: string | null;
}

export interface ProfileUpdateResult {
  user: UserRecord;
  recoveryFile: Buffer | null;
  recoveryToken: string | null;
  revokedOtherSessions: boolean;
}

export interface PasswordChangeResult {
  user: UserRecord;
  recoveryFile: Buffer | null;
  recoveryToken: string | null;
}

export interface KeyfileAuthenticatedResult extends AuthenticatedResult {
  recoveryToken: string;
}

export interface RecoveryCredentialsInput {
  recoveryVerifier?: string | undefined;
  encryptedPrivateKeyByRecovery?: string | undefined;
}

export interface ChangePasswordInput extends RecoveryCredentialsInput {
  currentPassword?: string | undefined;
  newPassword: string;
  newAuthSalt?: string | undefined;
  encryptedPrivateKeyByPassword?: string | undefined;
  sessionId: string;
}

export interface UpgradeCredentialsInput {
  currentPassword: string;
  newAuthSalt: string;
  newAuthKey: string;
  encryptedPrivateKeyByPassword: string;
  recoveryVerifier: string;
  encryptedPrivateKeyByRecovery: string;
}

export type AuthParams = { version: 1 } | { version: 2; salt: string };

export interface UpdateProfileInput {
  nickname: string;
  avatar: number;
  currentPassword?: string | undefined;
}

export interface SessionAuthentication {
  user: UserRecord;
  sessionId: string;
}

export interface PublishE2eKeysInput {
  signingPublicKey?: string | undefined;
  keySignature?: string | undefined;
  publicKey?: string | undefined;
  encryptedPrivateKeyByPassword?: string | undefined;
  encryptedPrivateKeyByRecovery?: string | undefined;
}

const DEFAULT_THEME = { baseTheme: 'dark', colorTheme: 'standard' };
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const KEYFILE_PASSWORD_RESET_WINDOW_MS = 10 * 60 * 1000;

export function isSessionLive(session: SessionRecord, now = Date.now()): boolean {
  const idleMs = now - new Date(session.lastUsedAt).getTime();
  const ageMs = now - new Date(session.createdAt).getTime();
  return idleMs <= SESSION_TTL_MS && ageMs <= SESSION_MAX_LIFETIME_MS;
}

function normalizeNickname(nickname: string): string {
  return nickname.trim().toLowerCase();
}

function assertValidNickname(nickname: string): void {
  if (!isValidNicknameFormat(nickname)) {
    throw AppError.of('user.nicknameInvalid', {
      minLength: NICKNAME_MIN_LENGTH,
      maxLength: NICKNAME_MAX_LENGTH,
      minLetters: NICKNAME_MIN_LETTERS,
    });
  }
}

function assertValidPassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw AppError.of('user.passwordTooShort', { minLength: PASSWORD_MIN_LENGTH });
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw AppError.of('user.passwordTooLong', { maxLength: PASSWORD_MAX_LENGTH });
  }
}

function assertClientSecret(value: unknown): asserts value is string {
  if (!isClientSecret(value)) {
    throw AppError.of('user.credentialsInvalid');
  }
}

function assertAuthSalt(value: unknown): asserts value is string {
  if (!isAuthSalt(value)) {
    throw AppError.of('user.credentialsInvalid');
  }
}

function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readRecoveryPair(
  input: RecoveryCredentialsInput,
  required: boolean,
): { recoveryVerifier: string; encryptedPrivateKeyByRecovery: string } | null {
  const { recoveryVerifier, encryptedPrivateKeyByRecovery } = input;
  const hasVerifier = isPresent(recoveryVerifier);
  const hasWrap = isPresent(encryptedPrivateKeyByRecovery);
  if (hasVerifier !== hasWrap || (required && !hasVerifier)) {
    throw AppError.of('user.credentialsIncomplete');
  }
  if (!isPresent(recoveryVerifier) || !isPresent(encryptedPrivateKeyByRecovery)) {
    return null;
  }
  assertClientSecret(recoveryVerifier);
  return { recoveryVerifier, encryptedPrivateKeyByRecovery };
}

function recoveryPatch(pair: { recoveryVerifier: string; encryptedPrivateKeyByRecovery: string }): Partial<UserRecord> {
  return {
    recoveryTokenHash: hashToken(pair.recoveryVerifier),
    e2eEncryptedPrivateKeyByRecovery: pair.encryptedPrivateKeyByRecovery,
  };
}

export interface RoomRotationNotice {
  roomId: string;
  epoch: number;
}

export class UserService {
  private dummyPasswordHash: Promise<string> | null = null;
  private readonly consumedKeyfileGrants = new Map<string, number>();
  private readonly fakeSaltKey: Buffer;

  constructor(
    private readonly repository: UserRepository,
    private readonly sessions: UserSessionRepository,
    private readonly recoveryFileSecret: string,
  ) {
    this.fakeSaltKey = deriveFakeSaltKey(recoveryFileSecret);
  }

  async registerAccount(input: RegisterAccountInput): Promise<RegisteredResult> {
    assertValidNickname(input.nickname);

    const hasAuthSalt = isPresent(input.authSalt);
    const hasVerifier = isPresent(input.recoveryVerifier);
    if (hasAuthSalt !== hasVerifier) {
      throw AppError.of('user.credentialsIncomplete');
    }
    const isV2 = hasAuthSalt && hasVerifier;
    if (isV2) {
      assertClientSecret(input.password);
      assertAuthSalt(input.authSalt);
      assertClientSecret(input.recoveryVerifier);
    } else {
      assertValidPassword(input.password);
    }

    const nicknameNormalized = normalizeNickname(input.nickname);
    const existing = await this.repository.findByNickname(nicknameNormalized);
    if (existing) {
      throw AppError.of('user.nicknameTaken');
    }

    const now = new Date().toISOString();
    const passwordHash = await hashPassword(input.password);
    const recoveryToken = isV2 ? null : generateToken();
    const recoverySecret = recoveryToken ?? input.recoveryVerifier ?? '';

    const user: UserRecord = {
      id: randomUUID(),
      nickname: input.nickname.trim(),
      nicknameNormalized,
      avatar: input.avatar,
      passwordHash,
      recoveryTokenHash: hashToken(recoverySecret),
      status: 'online',
      statusText: null,
      createdAt: now,
      lastSeen: now,
      authSalt: isV2 ? (input.authSalt ?? null) : null,
      authVersion: isV2 ? 2 : 1,
    };

    const created = await this.repository.insert(user);
    const { sessionId, sessionToken } = await this.createSession(created.id, 'password', input.userAgent ?? '');
    const recoveryFile = recoveryToken ? this.buildRecoveryFile(created.id, recoveryToken) : null;

    return { user: created, sessionId, sessionToken, recoveryFile, recoveryToken };
  }

  async getAuthParams(nickname: string): Promise<AuthParams> {
    const nicknameNormalized = normalizeNickname(nickname);
    const user = await this.repository.findByNickname(nicknameNormalized);
    if (!user || user.id === ASSISTANT_USER_ID) {
      return { version: 2, salt: fakeAuthSalt(this.fakeSaltKey, nicknameNormalized) };
    }
    if (authVersionOf(user) === 1) {
      return { version: 1 };
    }
    return { version: 2, salt: user.authSalt ?? fakeAuthSalt(this.fakeSaltKey, nicknameNormalized) };
  }

  async loginWithRecovery(userId: string, recoveryKey: string, userAgent = ''): Promise<AuthenticatedResult | null> {
    if (!isClientSecret(recoveryKey)) {
      return null;
    }

    const user = await this.repository.findById(userId);
    if (!user || user.id === ASSISTANT_USER_ID) {
      return null;
    }

    if (!constantTimeEqual(hashToken(recoveryKey), user.recoveryTokenHash)) {
      return null;
    }

    const { sessionId, sessionToken } = await this.createSession(user.id, 'keyfile', userAgent);
    return { user, sessionId, sessionToken };
  }

  async login(nickname: string, password: string, userAgent = ''): Promise<AuthenticatedResult | null> {
    if (password.length > PASSWORD_MAX_LENGTH) {
      return null;
    }

    const user = await this.repository.findByNickname(normalizeNickname(nickname));
    if (!user || user.id === ASSISTANT_USER_ID) {
      await verifyPassword(password, await this.getDummyPasswordHash());
      return null;
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return null;
    }

    await this.rehashPasswordIfNeeded(user, password);
    const { sessionId, sessionToken } = await this.createSession(user.id, 'password', userAgent);
    return { user, sessionId, sessionToken };
  }

  async loginWithKeyfile(fileBuffer: Buffer, userAgent = ''): Promise<KeyfileAuthenticatedResult | null> {
    let payload;
    try {
      payload = decodeRecoveryFile(fileBuffer, this.recoveryFileSecret);
    } catch {
      return null;
    }

    const user = await this.repository.findById(payload.userId);
    if (!user) {
      return null;
    }

    if (!constantTimeEqual(hashToken(payload.recoveryToken), user.recoveryTokenHash)) {
      return null;
    }

    const { sessionId, sessionToken } = await this.createSession(user.id, 'keyfile', userAgent);
    return { user, sessionId, sessionToken, recoveryToken: payload.recoveryToken };
  }

  async authenticateSession(userId: string, sessionToken: string): Promise<SessionAuthentication | null> {
    const session = await this.findLiveSessionByToken(userId, sessionToken);
    if (!session) {
      return null;
    }

    const user = await this.repository.findById(userId);
    if (!user) {
      return null;
    }

    await this.sessions.touch(session.id);
    return { user, sessionId: session.id };
  }

  async verifySession(userId: string, sessionToken: string): Promise<UserRecord | null> {
    const authenticated = await this.authenticateSession(userId, sessionToken);
    return authenticated?.user ?? null;
  }

  async isSessionActive(userId: string, sessionId: string): Promise<boolean> {
    const session = await this.sessions.findByIdForUser(userId, sessionId);
    return session !== null && isSessionLive(session);
  }

  async resumeSession(
    userId: string,
    sessionToken: string,
  ): Promise<{ user: UserRecord; authMethod: AuthMethod; sessionId: string } | null> {
    const session = await this.findLiveSessionByToken(userId, sessionToken);
    if (!session) {
      return null;
    }

    await this.sessions.touch(session.id);
    const user = await this.repository.update(userId, {
      status: 'online',
      lastSeen: new Date().toISOString(),
    });

    return user ? { user, authMethod: session.authMethod, sessionId: session.id } : null;
  }

  async changePassword(userId: string, input: ChangePasswordInput): Promise<PasswordChangeResult> {
    const user = await this.repository.findById(userId);
    if (!user) {
      throw AppError.of('user.notFound');
    }

    const credentialPatch = this.buildPasswordCredentialPatch(user, input);
    if (!credentialPatch) {
      assertValidPassword(input.newPassword);
    }

    let consumedGrant = false;
    if (input.currentPassword) {
      await this.assertCurrentPassword(user, input.currentPassword);
    } else {
      const session = await this.sessions.findByIdForUser(userId, input.sessionId);
      if (!session || !this.consumeKeyfileGrant(session)) {
        throw AppError.of('user.currentPasswordRequired');
      }
      consumedGrant = true;
    }

    try {
      const passwordHash = await hashPassword(input.newPassword);
      const recoveryToken = credentialPatch ? null : generateToken();

      const updated = await this.repository.update(userId, {
        passwordHash,
        ...(recoveryToken ? { recoveryTokenHash: hashToken(recoveryToken) } : credentialPatch),
      });
      if (!updated) {
        throw AppError.of('user.notFound');
      }

      await this.sessions.deleteAllForUser(userId);

      return {
        user: updated,
        recoveryFile: recoveryToken ? this.buildRecoveryFile(updated.id, recoveryToken) : null,
        recoveryToken,
      };
    } catch (error) {
      if (consumedGrant) {
        this.consumedKeyfileGrants.delete(input.sessionId);
      }
      throw error;
    }
  }

  async regenerateRecoveryFile(
    userId: string,
    currentPassword: string | undefined,
    currentSessionId: string,
    recovery: RecoveryCredentialsInput = {},
  ): Promise<PasswordChangeResult> {
    const user = await this.repository.findById(userId);
    if (!user) {
      throw AppError.of('user.notFound');
    }

    const pair = authVersionOf(user) === 2 ? readRecoveryPair(recovery, true) : null;

    await this.assertCurrentPassword(user, currentPassword);

    const recoveryToken = pair ? null : generateToken();
    const updated = await this.repository.update(userId, pair ? recoveryPatch(pair) : { recoveryTokenHash: hashToken(recoveryToken ?? '') });
    if (!updated) {
      throw AppError.of('user.notFound');
    }

    await this.sessions.deleteAllForUserExcept(userId, currentSessionId);

    return {
      user: updated,
      recoveryFile: recoveryToken ? this.buildRecoveryFile(updated.id, recoveryToken) : null,
      recoveryToken,
    };
  }

  async upgradeCredentials(userId: string, input: UpgradeCredentialsInput): Promise<UserRecord> {
    const user = await this.repository.findById(userId);
    if (!user) {
      throw AppError.of('user.notFound');
    }

    if (authVersionOf(user) === 2) {
      throw AppError.of('user.credentialsAlreadyUpgraded');
    }

    assertAuthSalt(input.newAuthSalt);
    assertClientSecret(input.newAuthKey);
    if (!isPresent(input.encryptedPrivateKeyByPassword)) {
      throw AppError.of('user.credentialsIncomplete');
    }
    const pair = readRecoveryPair(input, true);

    await this.assertCurrentPassword(user, input.currentPassword);

    const passwordHash = await hashPassword(input.newAuthKey);
    const updated = await this.repository.updateIfLegacyAuth(userId, {
      passwordHash,
      authSalt: input.newAuthSalt,
      authVersion: 2,
      e2eEncryptedPrivateKeyByPassword: input.encryptedPrivateKeyByPassword,
      ...(pair ? recoveryPatch(pair) : {}),
    });
    if (!updated) {
      throw AppError.of('user.credentialsAlreadyUpgraded');
    }

    return updated;
  }

  async updateProfile(userId: string, input: UpdateProfileInput, currentSessionId: string): Promise<ProfileUpdateResult | null> {
    assertValidNickname(input.nickname);

    const current = await this.repository.findById(userId);
    if (!current) {
      return null;
    }

    const nicknameNormalized = normalizeNickname(input.nickname);
    const nicknameChanged = nicknameNormalized !== current.nicknameNormalized;

    if (!nicknameChanged) {
      const updated = await this.repository.update(userId, {
        nickname: input.nickname.trim(),
        avatar: input.avatar,
      });
      return updated ? { user: updated, recoveryFile: null, recoveryToken: null, revokedOtherSessions: false } : null;
    }

    await this.assertCurrentPassword(current, input.currentPassword);

    const existing = await this.repository.findByNickname(nicknameNormalized);
    if (existing && existing.id !== userId) {
      throw AppError.of('user.nicknameTaken');
    }

    const recoveryToken = authVersionOf(current) === 2 ? null : generateToken();
    const updated = await this.repository.update(userId, {
      nickname: input.nickname.trim(),
      nicknameNormalized,
      avatar: input.avatar,
      ...(recoveryToken ? { recoveryTokenHash: hashToken(recoveryToken) } : {}),
    });

    if (!updated) {
      return null;
    }

    await this.sessions.deleteAllForUserExcept(userId, currentSessionId);

    return {
      user: updated,
      recoveryFile: recoveryToken ? this.buildRecoveryFile(updated.id, recoveryToken) : null,
      recoveryToken,
      revokedOtherSessions: true,
    };
  }

  getUser(userId: string): Promise<UserRecord | null> {
    return this.repository.findById(userId);
  }

  async getUsersByIds(userIds: string[]): Promise<Map<string, UserRecord>> {
    const records = await this.repository.findByIds(userIds);
    return new Map(records.map((user) => [user.id, user]));
  }

  getUserByNickname(nickname: string): Promise<UserRecord | null> {
    return this.repository.findByNickname(normalizeNickname(nickname));
  }

  isOnline(userId: string): boolean {
    return this.repository.isOnline(userId);
  }

  getCachedProfile(userId: string): { id: string; nickname: string; avatar: number } | undefined {
    return this.repository.getCachedProfile(userId);
  }

  setStatus(userId: string, status: UserStatus): Promise<UserRecord | null> {
    return this.repository.update(userId, {
      status,
      lastSeen: new Date().toISOString(),
    });
  }

  updateTheme(userId: string, theme: UserTheme): Promise<UserRecord | null> {
    return this.repository.update(userId, { theme });
  }

  updateChatSettings(userId: string, chatSettings: UserChatSettings): Promise<UserRecord | null> {
    return this.repository.update(userId, { chatSettings });
  }

  updateStatusText(userId: string, statusText: string): Promise<UserRecord | null> {
    const trimmed = statusText.trim();
    return this.repository.update(userId, { statusText: trimmed.length > 0 ? trimmed : null });
  }

  async listSessions(userId: string): Promise<SessionRecord[]> {
    const allSessions = await this.sessions.listByUser(userId);
    const now = Date.now();

    return allSessions.filter((session) => isSessionLive(session, now));
  }

  revokeSession(userId: string, sessionId: string): Promise<void> {
    return this.sessions.deleteByIdForUser(userId, sessionId);
  }

  async publishE2eKeys(userId: string, input: PublishE2eKeysInput): Promise<RoomRotationNotice[]> {
    const patch: Partial<UserRecord> = {};
    if (input.publicKey !== undefined) {
      patch.e2ePublicKey = input.publicKey;
    }
    if (input.encryptedPrivateKeyByPassword !== undefined) {
      patch.e2eEncryptedPrivateKeyByPassword = input.encryptedPrivateKeyByPassword;
    }
    if (input.encryptedPrivateKeyByRecovery !== undefined) {
      patch.e2eEncryptedPrivateKeyByRecovery = input.encryptedPrivateKeyByRecovery;
    }

    const hasSigning = input.signingPublicKey !== undefined && input.keySignature !== undefined;
    if (Object.keys(patch).length === 0 && !hasSigning) {
      return [];
    }

    const current = await this.repository.findById(userId);
    if (current && authVersionOf(current) === 2) {
      const locked =
        (patch.e2ePublicKey !== undefined && Boolean(current.e2ePublicKey)) ||
        (patch.e2eEncryptedPrivateKeyByPassword !== undefined && Boolean(current.e2eEncryptedPrivateKeyByPassword)) ||
        (patch.e2eEncryptedPrivateKeyByRecovery !== undefined && Boolean(current.e2eEncryptedPrivateKeyByRecovery));
      if (locked) {
        throw AppError.of('e2e.keysLocked');
      }
    }

    const publicKeyChanges = patch.e2ePublicKey !== undefined && patch.e2ePublicKey !== current?.e2ePublicKey;
    if (publicKeyChanges) {
      patch.e2eSigningPublicKey = null;
      patch.e2eKeySignature = null;
    }
    if (hasSigning && input.signingPublicKey !== undefined && input.keySignature !== undefined) {
      const effectivePublicKey = patch.e2ePublicKey ?? current?.e2ePublicKey;
      const valid =
        effectivePublicKey !== undefined &&
        effectivePublicKey !== null &&
        verifyIdentityBinding({ userId, publicKey: effectivePublicKey, signingPublicKey: input.signingPublicKey, keySignature: input.keySignature });
      if (!valid) {
        throw AppError.of('e2e.invalidSigningKey');
      }
      if (!publicKeyChanges && current?.e2eSigningPublicKey && current.e2eSigningPublicKey !== input.signingPublicKey) {
        throw AppError.of('e2e.signingKeyLocked');
      }
      patch.e2eSigningPublicKey = input.signingPublicKey;
      patch.e2eKeySignature = input.keySignature;
    }

    const previousPublicKey = patch.e2ePublicKey === undefined ? undefined : current?.e2ePublicKey;
    await this.repository.update(userId, patch);

    if (previousPublicKey && previousPublicKey !== patch.e2ePublicKey) {
      return this.repository.markRoomsForRotation(userId);
    }
    return [];
  }

  async publishSigningKey(userId: string, input: { signingPublicKey: string; keySignature: string }): Promise<void> {
    const current = await this.repository.findById(userId);
    if (!current?.e2ePublicKey) {
      throw AppError.of('e2e.invalidSigningKey');
    }

    const valid = verifyIdentityBinding({
      userId,
      publicKey: current.e2ePublicKey,
      signingPublicKey: input.signingPublicKey,
      keySignature: input.keySignature,
    });
    if (!valid) {
      throw AppError.of('e2e.invalidSigningKey');
    }

    if (current.e2eSigningPublicKey) {
      if (current.e2eSigningPublicKey === input.signingPublicKey) {
        return;
      }
      throw AppError.of('e2e.signingKeyLocked');
    }

    const stored = await this.repository.setSigningKeyIfUnset(userId, current.e2ePublicKey, input.signingPublicKey, input.keySignature);
    if (!stored) {
      const latest = await this.repository.findById(userId);
      if (latest?.e2eSigningPublicKey === input.signingPublicKey && latest.e2ePublicKey === current.e2ePublicKey) {
        return;
      }
      throw AppError.of('e2e.signingKeyLocked');
    }
  }

  async getPublicKeys(userIds: string[]): Promise<E2ePublicKeyEntry[]> {
    const unique = [...new Set(userIds)];
    const usersById = await this.getUsersByIds(unique);

    return unique
      .map((id) => usersById.get(id))
      .filter((user): user is UserRecord & { e2ePublicKey: string } => Boolean(user?.e2ePublicKey))
      .map((user) => ({
        userId: user.id,
        publicKey: user.e2ePublicKey,
        ...(user.e2eSigningPublicKey && user.e2eKeySignature
          ? { signingPublicKey: user.e2eSigningPublicKey, keySignature: user.e2eKeySignature }
          : {}),
      }));
  }

  toPublicUser(user: UserRecord): PublicUser {
    return {
      id: user.id,
      nickname: user.nickname,
      avatar: user.avatar,
      status: user.status,
      statusText: user.statusText,
      theme: user.theme ?? DEFAULT_THEME,
      chatSettings: user.chatSettings ?? null,
    };
  }

  private async createSession(
    userId: string,
    authMethod: AuthMethod,
    userAgent: string,
  ): Promise<{ sessionId: string; sessionToken: string }> {
    const sessionToken = generateToken();
    const sessionId = randomUUID();
    const now = new Date().toISOString();

    await this.sessions.create({
      id: sessionId,
      userId,
      tokenHash: hashToken(sessionToken),
      authMethod,
      userAgent,
      createdAt: now,
      lastUsedAt: now,
    });

    return { sessionId, sessionToken };
  }

  private async findLiveSessionByToken(userId: string, sessionToken: string): Promise<SessionRecord | null> {
    const session = await this.sessions.findByTokenForUser(userId, hashToken(sessionToken));
    return session && isSessionLive(session) ? session : null;
  }

  private async assertCurrentPassword(user: UserRecord, currentPassword: string | undefined): Promise<void> {
    const isValid =
      typeof currentPassword === 'string' &&
      currentPassword.length > 0 &&
      currentPassword.length <= PASSWORD_MAX_LENGTH &&
      (await verifyPassword(currentPassword, user.passwordHash));
    if (!isValid) {
      throw AppError.of('user.currentPasswordIncorrect');
    }
  }

  private buildPasswordCredentialPatch(user: UserRecord, input: ChangePasswordInput): Partial<UserRecord> | null {
    const isV2User = authVersionOf(user) === 2;
    const sentV2Fields = [input.newAuthSalt, input.encryptedPrivateKeyByPassword, input.recoveryVerifier, input.encryptedPrivateKeyByRecovery].some(
      (value) => value !== undefined,
    );
    if (!isV2User && !sentV2Fields) {
      return null;
    }

    if (!isPresent(input.newAuthSalt) || !isPresent(input.encryptedPrivateKeyByPassword)) {
      throw AppError.of('user.credentialsIncomplete');
    }
    assertAuthSalt(input.newAuthSalt);
    assertClientSecret(input.newPassword);
    const pair = readRecoveryPair(input, !isV2User);

    return {
      authSalt: input.newAuthSalt,
      authVersion: 2,
      e2eEncryptedPrivateKeyByPassword: input.encryptedPrivateKeyByPassword,
      ...(pair ? recoveryPatch(pair) : {}),
    };
  }

  private consumeKeyfileGrant(session: SessionRecord): boolean {
    const now = Date.now();
    for (const [sessionId, expiresAt] of this.consumedKeyfileGrants) {
      if (expiresAt <= now) {
        this.consumedKeyfileGrants.delete(sessionId);
      }
    }

    if (session.authMethod !== 'keyfile' || this.consumedKeyfileGrants.has(session.id)) {
      return false;
    }

    const expiresAt = new Date(session.createdAt).getTime() + KEYFILE_PASSWORD_RESET_WINDOW_MS;
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return false;
    }

    this.consumedKeyfileGrants.set(session.id, expiresAt);
    return true;
  }

  private async rehashPasswordIfNeeded(user: UserRecord, password: string): Promise<void> {
    if (!passwordHashNeedsRehash(user.passwordHash)) {
      return;
    }

    try {
      const passwordHash = await hashPassword(password);
      await this.repository.update(user.id, { passwordHash });
    } catch (err) {
      logger.warn({ err, userId: user.id }, 'Failed to upgrade password hash');
    }
  }

  private buildRecoveryFile(userId: string, recoveryToken: string): Buffer {
    return encodeRecoveryFile({ userId, recoveryToken }, this.recoveryFileSecret);
  }

  private getDummyPasswordHash(): Promise<string> {
    if (!this.dummyPasswordHash) {
      this.dummyPasswordHash = hashPassword(generateToken());
    }
    return this.dummyPasswordHash;
  }
}
