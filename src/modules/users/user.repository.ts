import { JsonRepository } from '../../database/json-repository.js';
import type { UserRecord } from './user.types.js';

export class UserRepository extends JsonRepository<UserRecord> {
  async findByLoginCode(loginCode: string): Promise<UserRecord | null> {
    const users = await this.findAll();
    return users.find((user) => user.loginCode === loginCode) ?? null;
  }

  async findByChatCode(chatCode: string): Promise<UserRecord | null> {
    const users = await this.findAll();
    const normalized = chatCode.toUpperCase().trim();
    return users.find((user) => user.chatCode === normalized) ?? null;
  }
}
