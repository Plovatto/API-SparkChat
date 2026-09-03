import { randomUUID } from 'node:crypto';
import {
  isValidNicknameFormat,
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
  NICKNAME_MIN_LETTERS,
  PASSWORD_MIN_LENGTH,
  type AuthMethod,
  type PublicUser,
  type UserStatus,
  type UserTheme,
} from './user.model.js';
import { hashPassword, verifyPassword } from './user.password.js';
import { decodeRecoveryFile, encodeRecoveryFile } from './user.recovery-file.js';
import type { UserRepository } from './user.repository.js';
import type { UserSessionRepository } from './user.session.repository.js';
import { constantTimeEqual, generateToken, hashToken } from './user.token.js';
import type { SessionRecord, UserRecord } from './user.types.js';

export interface RegisterAccountInput {
  nickname: string;
  avatar: number;
  password: string;
  socketId: string;
  userAgent?: string;
}

export interface AuthenticatedResult {
  user: UserRecord;
  sessionToken: string;
  sessionId: string;
}

export interface RegisteredResult extends AuthenticatedResult {
  recoveryFile: Buffer;
}

export interface ProfileUpdateResult {
  user: UserRecord;
  recoveryFile: Buffer | null;
}

export interface PasswordChangeResult {
  user: UserRecord;
  recoveryFile: Buffer;
}

const DEFAULT_THEME = { baseTheme: 'dark', colorTheme: 'standard' };
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeNickname(nickname: string): string {
  return nickname.trim().toLowerCase();
}

function assertValidNickname(nickname: string): void {
  if (!isValidNicknameFormat(nickname)) {
    throw new Error(
      `Nickname deve ter entre ${NICKNAME_MIN_LENGTH} e ${NICKNAME_MAX_LENGTH} caracteres, usando apenas letras e números, com pelo menos ${NICKNAME_MIN_LETTERS} letras.`,
    );
  }
}

function assertValidPassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`A senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`);
  }
}

export class UserService {
  private dummyPasswordHash: Promise<string> | null = null;

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
      throw new Error('Esse nickname já está em uso.');
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
      socketId: input.socketId,
      status: 'online',
      statusText: null,
      createdAt: now,
      lastSeen: now,
    };

    const created = await this.repository.insert(user);
    const { sessionId, sessionToken } = await this.createSession(created.id, 'password', input.userAgent ?? '');
    const recoveryFile = this.buildRecoveryFile(created.id, recoveryToken);

    return { user: created, sessionId, sessionToken, recoveryFile };
  }

  async login(nickname: string, password: string, userAgent = ''): Promise<AuthenticatedResult | null> {
    const user = await this.repository.findByNickname(normalizeNickname(nickname));
    if (!user) {
      await verifyPassword(password, await this.getDummyPasswordHash());
      return null;
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return null;
    }

    const { sessionId, sessionToken } = await this.createSession(user.id, 'password', userAgent);
    return { user, sessionId, sessionToken };
  }

  async loginWithKeyfile(fileBuffer: Buffer, userAgent = ''): Promise<AuthenticatedResult | null> {
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
    return { user, sessionId, sessionToken };
  }

  async verifySession(userId: string, sessionToken: string): Promise<UserRecord | null> {
    const session = await this.sessions.findValid(userId, hashToken(sessionToken), SESSION_TTL_MS);
    if (!session) {
      return null;
    }

    const user = await this.repository.findById(userId);
    if (!user) {
      return null;
    }

    await this.sessions.touch(session.id);
    return user;
  }

  async resumeSession(
    userId: string,
    sessionToken: string,
    socketId: string,
  ): Promise<{ user: UserRecord; authMethod: AuthMethod; sessionId: string } | null> {
    const session = await this.sessions.findValid(userId, hashToken(sessionToken), SESSION_TTL_MS);
    if (!session) {
      return null;
    }

    await this.sessions.touch(session.id);
    const user = await this.repository.update(userId, {
      socketId,
      status: 'online',
      lastSeen: new Date().toISOString(),
    });

    return user ? { user, authMethod: session.authMethod, sessionId: session.id } : null;
  }

  async changePassword(
    userId: string,
    currentPassword: string | undefined,
    newPassword: string,
    sessionAuthMethod: AuthMethod,
  ): Promise<PasswordChangeResult> {
    const user = await this.repository.findById(userId);
    if (!user) {
      throw new Error('Usuário não encontrado.');
    }

    if (sessionAuthMethod === 'password') {
      const isValid = Boolean(currentPassword) && (await verifyPassword(currentPassword ?? '', user.passwordHash));
      if (!isValid) {
        throw new Error('Senha atual incorreta.');
      }
    }

    assertValidPassword(newPassword);

    const passwordHash = await hashPassword(newPassword);
    const recoveryToken = generateToken();

    const updated = await this.repository.update(userId, {
      passwordHash,
      recoveryTokenHash: hashToken(recoveryToken),
    });
    if (!updated) {
      throw new Error('Usuário não encontrado.');
    }

    await this.sessions.deleteAllForUser(userId);

    return { user: updated, recoveryFile: this.buildRecoveryFile(updated.id, recoveryToken) };
  }

  async regenerateRecoveryFile(userId: string): Promise<PasswordChangeResult> {
    const user = await this.repository.findById(userId);
    if (!user) {
      throw new Error('Usuário não encontrado.');
    }

    const recoveryToken = generateToken();
    const updated = await this.repository.update(userId, { recoveryTokenHash: hashToken(recoveryToken) });
    if (!updated) {
      throw new Error('Usuário não encontrado.');
    }

    return { user: updated, recoveryFile: this.buildRecoveryFile(updated.id, recoveryToken) };
  }

  async updateProfile(userId: string, input: { nickname: string; avatar: number }): Promise<ProfileUpdateResult | null> {
    assertValidNickname(input.nickname);

    const current = await this.repository.findById(userId);
    if (!current) {
      return null;
    }

    const nicknameNormalized = normalizeNickname(input.nickname);
    const nicknameChanged = nicknameNormalized !== current.nicknameNormalized;

    if (nicknameChanged) {
      const existing = await this.repository.findByNickname(nicknameNormalized);
      if (existing && existing.id !== userId) {
        throw new Error('Esse nickname já está em uso.');
      }
    }

    if (!nicknameChanged) {
      const updated = await this.repository.update(userId, {
        nickname: input.nickname.trim(),
        avatar: input.avatar,
      });
      return updated ? { user: updated, recoveryFile: null } : null;
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

    return { user: updated, recoveryFile: this.buildRecoveryFile(updated.id, recoveryToken) };
  }

  getUser(userId: string): Promise<UserRecord | null> {
    return this.repository.findById(userId);
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

  updateStatusText(userId: string, statusText: string): Promise<UserRecord | null> {
    const trimmed = statusText.trim();
    return this.repository.update(userId, { statusText: trimmed.length > 0 ? trimmed : null });
  }

  async listSessions(userId: string): Promise<SessionRecord[]> {
    const allSessions = await this.sessions.listByUser(userId);
    const cutoff = Date.now() - SESSION_TTL_MS;

    return allSessions.filter((session) => new Date(session.lastUsedAt).getTime() > cutoff);
  }

  revokeSession(userId: string, sessionId: string): Promise<void> {
    return this.sessions.deleteByIdForUser(userId, sessionId);
  }

  toPublicUser(user: UserRecord): PublicUser {
    return {
      id: user.id,
      nickname: user.nickname,
      avatar: user.avatar,
      status: user.status,
      statusText: user.statusText,
      theme: user.theme ?? DEFAULT_THEME,
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
