import { randomUUID } from 'node:crypto';
import type { UserService } from '../users/index.js';
import type { MessageRepository } from './message.repository.js';
import type { MessageRecord, MessageReplySnapshot, MessageSender, MessageView } from './message.types.js';

export interface SendMessageInput {
  roomId: string;
  senderId: string;
  content: string;
  replyToMessageId?: string | undefined;
}

export class MessageService {
  constructor(
    private readonly repository: MessageRepository,
    private readonly userService: UserService,
  ) {}

  async sendMessage(input: SendMessageInput): Promise<MessageRecord> {
    const message: MessageRecord = {
      id: randomUUID(),
      roomId: input.roomId,
      senderId: input.senderId,
      content: input.content,
      type: 'text',
      timestamp: new Date().toISOString(),
      deletedForEveryone: false,
      status: 'sent',
      deliveredTo: [],
      readBy: [],
      replyTo: input.replyToMessageId ? await this.buildReplySnapshot(input.replyToMessageId) : null,
    };

    return this.repository.insert(message);
  }

  async createSystemMessage(roomId: string, content: string): Promise<MessageRecord> {
    const message: MessageRecord = {
      id: randomUUID(),
      roomId,
      senderId: 'system',
      content,
      type: 'system',
      timestamp: new Date().toISOString(),
      deletedForEveryone: false,
      status: 'sent',
      deliveredTo: [],
      readBy: [],
      replyTo: null,
    };

    return this.repository.insert(message);
  }

  getRoomMessages(roomId: string): Promise<MessageRecord[]> {
    return this.repository.findByRoomId(roomId);
  }

  async deleteMessage(messageId: string, requesterId: string): Promise<MessageRecord> {
    const message = await this.repository.findById(messageId);
    if (!message) {
      throw new Error('Mensagem não encontrada.');
    }

    if (message.senderId !== requesterId) {
      throw new Error('Você não tem permissão para deletar esta mensagem.');
    }

    const updated = await this.repository.update(messageId, { deletedForEveryone: true, content: '' });
    if (!updated) {
      throw new Error('Mensagem não encontrada.');
    }

    return updated;
  }

  async getLastMessage(roomId: string): Promise<MessageRecord | null> {
    const messages = await this.repository.findByRoomId(roomId);
    return messages.length > 0 ? (messages[messages.length - 1] ?? null) : null;
  }

  async markRoomAsRead(roomId: string, userId: string): Promise<MessageRecord[]> {
    const messages = await this.repository.findByRoomId(roomId);
    let changed = false;

    const updated = messages.map((message) => {
      if (message.senderId === userId || message.readBy.includes(userId)) {
        return message;
      }

      changed = true;
      return { ...message, readBy: [...message.readBy, userId], status: 'read' as const };
    });

    if (!changed) {
      return messages;
    }

    const all = await this.repository.findAll();
    const updatedById = new Map(updated.map((message) => [message.id, message]));
    const merged = all.map((message) => updatedById.get(message.id) ?? message);
    await this.repository.replaceAll(merged);

    return updated;
  }

  countUnread(messages: MessageRecord[], userId: string): number {
    return messages.filter(
      (message) => message.senderId !== userId && !message.deletedForEveryone && !message.readBy.includes(userId),
    ).length;
  }

  async toView(message: MessageRecord): Promise<MessageView> {
    return {
      id: message.id,
      roomId: message.roomId,
      sender: await this.resolveSender(message.senderId),
      content: message.deletedForEveryone ? '' : message.content,
      type: message.type,
      timestamp: message.timestamp,
      deletedForEveryone: message.deletedForEveryone,
      status: message.status,
      deliveredTo: message.deliveredTo,
      readBy: message.readBy,
      replyTo: message.replyTo,
    };
  }

  toViews(messages: MessageRecord[]): Promise<MessageView[]> {
    return Promise.all(messages.map((message) => this.toView(message)));
  }

  private async buildReplySnapshot(messageId: string): Promise<MessageReplySnapshot | null> {
    const original = await this.repository.findById(messageId);
    if (!original) {
      return null;
    }

    return {
      id: original.id,
      content: original.content,
      type: original.type,
      sender: await this.resolveSender(original.senderId),
    };
  }

  private async resolveSender(senderId: string): Promise<MessageSender> {
    if (senderId === 'system') {
      return { id: 'system', nickname: 'Sistema', avatar: null };
    }

    const user = await this.userService.getUser(senderId);
    if (!user) {
      return { id: senderId, nickname: 'Usuário desconhecido', avatar: null };
    }

    return { id: user.id, nickname: user.nickname, avatar: user.avatar };
  }
}
