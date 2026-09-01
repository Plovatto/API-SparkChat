import { eq } from 'drizzle-orm';
import type { Database } from '../../database/turso-client.js';
import { users } from '../../database/schema.js';
import type { UserRecord } from './user.types.js';

const socketIdsByUserId = new Map<string, string>();

function toRecord(row: typeof users.$inferSelect): UserRecord {
  const theme =
    row.themeBaseTheme && row.themeColorTheme
      ? { baseTheme: row.themeBaseTheme, colorTheme: row.themeColorTheme }
      : undefined;

  return {
    id: row.id,
    nickname: row.nickname,
    avatar: row.avatar,
    chatCode: row.chatCode,
    loginCode: row.loginCode,
    socketId: socketIdsByUserId.get(row.id) ?? '',
    status: row.status as UserRecord['status'],
    createdAt: row.createdAt,
    lastSeen: row.lastSeen,
    ...(theme ? { theme } : {}),
  };
}

function isSamePersistedUser(a: UserRecord, b: UserRecord): boolean {
  const { socketId: _a, ...restA } = a;
  const { socketId: _b, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

export class UserRepository {
  constructor(private readonly db: Database) {}

  async findAll(): Promise<UserRecord[]> {
    const rows = await this.db.select().from(users);
    return rows.map(toRecord);
  }

  async findById(id: string): Promise<UserRecord | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    return row ? toRecord(row) : null;
  }

  async insert(user: UserRecord): Promise<UserRecord> {
    socketIdsByUserId.set(user.id, user.socketId);

    await this.db.insert(users).values({
      id: user.id,
      nickname: user.nickname,
      avatar: user.avatar,
      loginCode: user.loginCode,
      chatCode: user.chatCode,
      status: user.status,
      createdAt: user.createdAt,
      lastSeen: user.lastSeen,
      themeBaseTheme: user.theme?.baseTheme,
      themeColorTheme: user.theme?.colorTheme,
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

    return current ? { ...current, ...patch } : null;
  }

  async replaceAll(items: UserRecord[]): Promise<void> {
    const current = await this.findAll();
    const currentById = new Map(current.map((user) => [user.id, user]));

    const changed = items.filter((item) => {
      const existing = currentById.get(item.id);
      return !(existing && isSamePersistedUser(existing, item));
    });

    await Promise.all(changed.map((item) => this.update(item.id, item)));
  }

  async findByLoginCode(loginCode: string): Promise<UserRecord | null> {
    const [row] = await this.db.select().from(users).where(eq(users.loginCode, loginCode));
    return row ? toRecord(row) : null;
  }

  async findByChatCode(chatCode: string): Promise<UserRecord | null> {
    const normalized = chatCode.toUpperCase().trim();
    const [row] = await this.db.select().from(users).where(eq(users.chatCode, normalized));
    return row ? toRecord(row) : null;
  }
}
