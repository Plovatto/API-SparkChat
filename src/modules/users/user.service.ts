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
import { hashPassword, passwordHashNeedsRehash, verifyPassword } from './user.password.js';
import { decodeRecoveryFile, encodeRecoveryFile } from './user.recovery-file.js';
import type { UserRepository } from './user.repository.js';
import type { UserSessionRepository } from './user.session.repository.js';
import { constantTimeEqual, generateToken, hashToken } from './user.token.js';
import type { SessionRecord, UserRecord } from './user.types.js';

export interface RegisterAccountInput {
  nickname: string;
  avatar: number;
  password: string;
  userAgent?: string;
}

export interface AuthenticatedResult {
  user: UserRecord;
  sessionToken: string;
  sessionId: string;
}

export interface RegisteredResult extends AuthenticatedResult {
  recoveryFile: Buffer;
  recoveryToken: string;
}

export interface ProfileUpdateResult {
  user: UserRecord;
  recoveryFile: Buffer | null;
  recoveryToken: string | null;
}

export interface PasswordChangeResult {
  user: UserRecord;
  recoveryFile: Buffer;
  recoveryToken: string;
}

export interface KeyfileAuthenticatedResult extends AuthenticatedResult {
  recoveryToken: string;
}

export interface ChangePasswordInput {
  currentPassword?: string | undefined;
  newPassword: string;
  sessionId: string;
}

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

export class UserService {
  private dummyPasswordHash: Promise<string> | null = null;
  private readonly consumedKeyfileGrants = new Map<string, number>();

  constructor(
    private readonly repository: UserRepository,
    private readonly sessions: UserSessionRepository,
    private readonly recoveryFileSecret: string,
  ) {}

  async registerAccount(input: RegisterAccountInput): Promise<RegisteredResult> {
    assertValidNickname(input.nickname);
    assertValidPassword(input.password);

    const nicknameNormalized = normalizeNickname(input.nickname);
    const existing = await this.repository.findByNickname(nicknameNormalized);
    if (existing) {
      throw AppError.of('user.nicknameTaken');
    }

    const now = new Date().toISOString();
    const passwordHash = await hashPassword(input.password);
    const recoveryToken = generateToken();

    const user: UserRecord = {
      id: randomUUID(),
      nickname: input.nickname.trim(),
      nicknameNormalized,
      avatar: input.avatar,
      passwordHash,
      recoveryTokenHash: hashToken(recoveryToken),
      status: 'online',
      statusText: null,
      createdAt: now,
      lastSeen: now,
    };

    const created = await this.repository.insert(user);
    const { sessionId, sessionToken } = await this.createSession(created.id, 'password', input.userAgent ?? '');
    const recoveryFile = this.buildRecoveryFile(created.id, recoveryToken);

    return { user: created, sessionId, sessionToken, recoveryFile, recoveryToken };
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

    assertValidPassword(input.newPassword);

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
      const recoveryToken = generateToken();

      const updated = await this.repository.update(userId, {
        passwordHash,
        recoveryTokenHash: hashToken(recoveryToken),
      });
      if (!updated) {
        throw AppError.of('user.notFound');
      }

      await this.sessions.deleteAllForUser(userId);

      return { user: updated, recoveryFile: this.buildRecoveryFile(updated.id, recoveryToken), recoveryToken };
    } catch (error) {
      if (consumedGrant) {
        this.consumedKeyfileGrants.delete(input.sessionId);
      }
      throw error;
    }
  }

  async regenerateRecoveryFile(userId: string, currentPassword: string | undefined, currentSessionId: string): Promise<PasswordChangeResult> {
    const user = await this.repository.findById(userId);
    if (!user) {
      throw AppError.of('user.notFound');
    }

    await this.assertCurrentPassword(user, currentPassword);

    const recoveryToken = generateToken();
    const updated = await this.repository.update(userId, { recoveryTokenHash: hashToken(recoveryToken) });
    if (!updated) {
      throw AppError.of('user.notFound');
    }

    await this.sessions.deleteAllForUserExcept(userId, currentSessionId);

    return { user: updated, recoveryFile: this.buildRecoveryFile(updated.id, recoveryToken), recoveryToken };
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
      return updated ? { user: updated, recoveryFile: null, recoveryToken: null } : null;
    }

    await this.assertCurrentPassword(current, input.currentPassword);

    const existing = await this.repository.findByNickname(nicknameNormalized);
    if (existing && existing.id !== userId) {
      throw AppError.of('user.nicknameTaken');
    }

    const recoveryToken = generateToken();
    const updated = await this.repository.update(userId, {
      nickname: input.nickname.trim(),
      nicknameNormalized,
      avatar: input.avatar,
      recoveryTokenHash: hashToken(recoveryToken),
    });

    if (!updated) {
      return null;
    }

    await this.sessions.deleteAllForUserExcept(userId, currentSessionId);

    return { user: updated, recoveryFile: this.buildRecoveryFile(updated.id, recoveryToken), recoveryToken };
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

  async publishE2eKeys(userId: string, input: PublishE2eKeysInput): Promise<void> {
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

    if (Object.keys(patch).length === 0) {
      return;
    }

    const previousPublicKey = patch.e2ePublicKey === undefined ? undefined : (await this.repository.findById(userId))?.e2ePublicKey;
    if (previousPublicKey && previousPublicKey !== patch.e2ePublicKey) {
      await this.repository.deleteRoomKeys(userId);
    }

    await this.repository.update(userId, patch);
  }

  async getPublicKeys(userIds: string[]): Promise<{ userId: string; publicKey: string }[]> {
    const unique = [...new Set(userIds)];
    const usersById = await this.getUsersByIds(unique);

    return unique
      .map((id) => usersById.get(id))
      .filter((user): user is UserRecord & { e2ePublicKey: string } => Boolean(user?.e2ePublicKey))
      .map((user) => ({ userId: user.id, publicKey: user.e2ePublicKey }));
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
