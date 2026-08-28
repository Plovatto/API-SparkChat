import { JsonRepository } from '../../database/json-repository.js';
import type { UserRecord } from './user.types.js';

export class UserRepository extends JsonRepository<UserRecord> {
  async findByLoginCode(loginCode: string): Promise<UserRecord | null> {
    const users = await this.findAll();
    return users.find((user) => user.loginCode === loginCode) ?? null;
  }
}
