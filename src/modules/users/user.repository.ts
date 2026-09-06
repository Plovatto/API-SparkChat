import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../../database/turso-client.js';
import { users } from '../../database/schema.js';
import type { UserRecord } from './user.types.js';

const MAX_IN_CLAUSE_IDS = 500;

const socketIdsByUserId = new Map<string, string>();
const onlineUserIds = new Set<string>();
const profileByUserId = new Map<string, { nickname: string; avatar: number }>();

function cacheProfile(user: UserRecord): void {
  profileByUserId.set(user.id, { nickname: user.nickname, avatar: user.avatar });
  if (user.status === 'online') {
    onlineUserIds.add(user.id);
  } else {
    onlineUserIds.delete(user.id);
  }
}

function toRecord(row: typeof users.$inferSelect): UserRecord {
  const theme =
    row.themeBaseTheme && row.themeColorTheme
      ? { baseTheme: row.themeBaseTheme, colorTheme: row.themeColorTheme }
      : undefined;

  const record: UserRecord = {
    id: row.id,
    nickname: row.nickname,
    nicknameNormalized: row.nicknameNormalized,
    avatar: row.avatar,
    passwordHash: row.passwordHash,
    recoveryTokenHash: row.recoveryTokenHash,
    socketId: socketIdsByUserId.get(row.id) ?? '',
    status: row.status,
    statusText: row.statusText ?? null,
    createdAt: row.createdAt,
    lastSeen: row.lastSeen,
    e2ePublicKey: row.e2ePublicKey,
    e2eEncryptedPrivateKeyByPassword: row.e2eEncryptedPrivateKeyByPassword,
    e2eEncryptedPrivateKeyByRecovery: row.e2eEncryptedPrivateKeyByRecovery,
    ...(theme ? { theme } : {}),
  };

  cacheProfile(record);
  return record;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export class UserRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<UserRecord | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    return row ? toRecord(row) : null;
  }

  async findByIds(ids: string[]): Promise<UserRecord[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      return [];
    }

    const pages = await Promise.all(
      chunk(unique, MAX_IN_CLAUSE_IDS).map((batch) => this.db.select().from(users).where(inArray(users.id, batch))),
    );

    return pages.flat().map(toRecord);
  }

  async insert(user: UserRecord): Promise<UserRecord> {
    socketIdsByUserId.set(user.id, user.socketId);
    cacheProfile(user);

    await this.db.insert(users).values({
      id: user.id,
      nickname: user.nickname,
      nicknameNormalized: user.nicknameNormalized,
      avatar: user.avatar,
      passwordHash: user.passwordHash,
      recoveryTokenHash: user.recoveryTokenHash,
      status: user.status,
      statusText: user.statusText,
      createdAt: user.createdAt,
      lastSeen: user.lastSeen,
      themeBaseTheme: user.theme?.baseTheme,
      themeColorTheme: user.theme?.colorTheme,
      e2ePublicKey: user.e2ePublicKey,
      e2eEncryptedPrivateKeyByPassword: user.e2eEncryptedPrivateKeyByPassword,
      e2eEncryptedPrivateKeyByRecovery: user.e2eEncryptedPrivateKeyByRecovery,
    });

    return user;
  }

  async update(id: string, patch: Partial<UserRecord>): Promise<UserRecord | null> {
    if (patch.socketId !== undefined) {
      socketIdsByUserId.set(id, patch.socketId);
    }

    const { socketId: _socketId, theme, ...rest } = patch;

    const columns: Partial<typeof users.$inferInsert> = { ...rest };
    if (theme !== undefined) {
      columns.themeBaseTheme = theme?.baseTheme;
      columns.themeColorTheme = theme?.colorTheme;
    }

    const [current] = await Promise.all([
      this.findById(id),
      Object.keys(columns).length > 0
        ? this.db.update(users).set(columns).where(eq(users.id, id))
        : Promise.resolve(),
    ]);

    if (!current) {
      return null;
    }

    const updated = { ...current, ...patch };
    cacheProfile(updated);
    return updated;
  }

  async findByNickname(nicknameNormalized: string): Promise<UserRecord | null> {
    const [row] = await this.db.select().from(users).where(eq(users.nicknameNormalized, nicknameNormalized));
    return row ? toRecord(row) : null;
  }

  isOnline(id: string): boolean {
    return onlineUserIds.has(id);
  }

  getCachedProfile(id: string): { id: string; nickname: string; avatar: number } | undefined {
    const cached = profileByUserId.get(id);
    return cached ? { id, ...cached } : undefined;
  }
}
