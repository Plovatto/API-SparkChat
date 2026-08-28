import type { JsonFileStore } from './json-file-store.js';
import type { UserRecord } from '../models/user.model.js';

export class UserRepository {
  constructor(private readonly store: JsonFileStore<UserRecord>) {}

  findAll(): Promise<UserRecord[]> {
    return this.store.read();
  }

  async findByLoginCode(loginCode: string): Promise<UserRecord | null> {
    const users = await this.store.read();
    return users.find((user) => user.loginCode === loginCode) ?? null;
  }

  async insert(user: UserRecord): Promise<UserRecord> {
    const users = await this.store.read();
    users.push(user);
    await this.store.write(users);
    return user;
  }

  async update(id: string, patch: Partial<UserRecord>): Promise<UserRecord | null> {
    const users = await this.store.read();
    const index = users.findIndex((user) => user.id === id);
    const current = users[index];

    if (index === -1 || !current) {
      return null;
    }

    const updated: UserRecord = { ...current, ...patch };
    users[index] = updated;
    await this.store.write(users);
    return updated;
  }

  async replaceAll(users: UserRecord[]): Promise<void> {
    await this.store.write(users);
  }
}
