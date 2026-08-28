import { randomUUID } from 'node:crypto';
import type { UserRepository } from '../database/user.repository.js';
import type { PublicUser, UserRecord, UserStatus } from '../models/user.model.js';
import { generateChatCode, generateLoginCode, isValidLoginCode } from '../utils/user-codes.js';

export interface JoinInput {
  nickname?: string | undefined;
  avatar?: number | undefined;
  loginCode?: string | null | undefined;
  socketId: string;
}

const DEFAULT_THEME = { baseTheme: 'dark', colorTheme: 'standard' };

export class UserService {
  constructor(private readonly repository: UserRepository) {}

  async joinOrCreate(input: JoinInput): Promise<UserRecord> {
    const { nickname, avatar, loginCode, socketId } = input;

    if (loginCode) {
      if (!isValidLoginCode(loginCode)) {
        throw new Error('Código de login inválido. Deve ser 6 dígitos numéricos.');
      }

      const existing = await this.repository.findByLoginCode(loginCode);
      if (!existing) {
        throw new Error('Código de login não encontrado.');
      }

      const updated = await this.repository.update(existing.id, {
        socketId,
        status: 'online',
        lastSeen: new Date().toISOString(),
      });

      if (!updated) {
        throw new Error('Código de login não encontrado.');
      }

      return updated;
    }

    if (!nickname || avatar === undefined) {
      throw new Error('Nickname e avatar são obrigatórios para criar nova conta.');
    }

    const now = new Date().toISOString();
    const user: UserRecord = {
      id: randomUUID(),
      nickname,
      avatar,
      chatCode: generateChatCode(),
      loginCode: generateLoginCode(),
      socketId,
      status: 'online',
      createdAt: now,
      lastSeen: now,
    };

    return this.repository.insert(user);
  }

  validateLoginCode(loginCode: string): Promise<UserRecord | null> {
    return this.repository.findByLoginCode(loginCode);
  }

  setStatus(userId: string, status: UserStatus): Promise<UserRecord | null> {
    return this.repository.update(userId, {
      status,
      lastSeen: new Date().toISOString(),
    });
  }

  async migrateLegacyCodes(): Promise<void> {
    const users = await this.repository.findAll();
    let migrated = false;

    const updated = users.map((user) => {
      if (user.chatCode && user.loginCode) {
        return user;
      }

      migrated = true;
      return {
        ...user,
        chatCode: user.chatCode || generateChatCode(),
        loginCode: user.loginCode || generateLoginCode(),
      };
    });

    if (migrated) {
      await this.repository.replaceAll(updated);
    }
  }

  toPublicUser(user: UserRecord): PublicUser {
    return {
      id: user.id,
      nickname: user.nickname,
      avatar: user.avatar,
      loginCode: user.loginCode,
      chatCode: user.chatCode,
      status: user.status,
      theme: user.theme ?? DEFAULT_THEME,
    };
  }
}
