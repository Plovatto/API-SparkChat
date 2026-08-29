import { JsonRepository } from '../../database/json-repository.js';
import type { MessageRecord } from './message.types.js';

export class MessageRepository extends JsonRepository<MessageRecord> {
  async findByRoomId(roomId: string): Promise<MessageRecord[]> {
    const messages = await this.findAll();
    return messages
      .filter((message) => message.roomId === roomId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }
}
