import { randomUUID } from 'node:crypto';
import type { UserRecord, UserService } from '../users/index.js';
import type { MessageRepository } from './message.repository.js';
import type { MessageRecord, MessageReplySnapshot, MessageSender, MessageType, MessageView } from './message.types.js';

export interface SendMessageInput {
  roomId: string;
  senderId: string;
  content: string;
  type?: Extract<MessageType, 'text' | 'image' | 'audio'> | undefined;
  duration?: number | undefined;
  replyToMessageId?: string | undefined;
  participantIds?: string[] | undefined;
}

export class MessageService {
  constructor(
    private readonly repository: MessageRepository,
    private readonly userService: UserService,
  ) {}

  async sendMessage(input: SendMessageInput): Promise<MessageRecord> {
    const deliveredTo = await this.resolveOnlineRecipients(input.participantIds ?? [], input.senderId);

    const message: MessageRecord = {
      id: randomUUID(),
      roomId: input.roomId,
      senderId: input.senderId,
      content: input.content,
      type: input.type ?? 'text',
      duration: input.type === 'audio' ? (input.duration ?? null) : null,
      timestamp: new Date().toISOString(),
      deletedForEveryone: false,
      status: deliveredTo.length > 0 ? 'delivered' : 'sent',
      deliveredTo,
      readBy: [],
      playedBy: [],
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
      duration: null,
      timestamp: new Date().toISOString(),
      deletedForEveryone: false,
      status: 'sent',
      deliveredTo: [],
      readBy: [],
      playedBy: [],
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
      const deliveredTo = message.deliveredTo.includes(userId) ? message.deliveredTo : [...message.deliveredTo, userId];
      return { ...message, readBy: [...message.readBy, userId], deliveredTo, status: 'read' as const };
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

  async markPendingMessagesDelivered(roomId: string, userId: string): Promise<MessageRecord[]> {
    const messages = await this.repository.findByRoomId(roomId);
    const pending = messages.filter(
      (message) =>
        message.senderId !== userId &&
        !message.deletedForEveryone &&
        !message.deliveredTo.includes(userId) &&
        !message.readBy.includes(userId),
    );

    if (pending.length === 0) {
      return [];
    }

    const pendingIds = new Set(pending.map((message) => message.id));
    const all = await this.repository.findAll();
    const merged = all.map((message) => {
      if (!pendingIds.has(message.id)) {
        return message;
      }
      return {
        ...message,
        deliveredTo: [...message.deliveredTo, userId],
        status: message.status === 'read' ? message.status : ('delivered' as const),
      };
    });
    await this.repository.replaceAll(merged);

    return merged.filter((message) => pendingIds.has(message.id));
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
      duration: message.duration,
      timestamp: message.timestamp,
      deletedForEveryone: message.deletedForEveryone,
      status: message.status,
      deliveredTo: message.deliveredTo,
      readBy: message.readBy,
      playedBy: message.playedBy,
      replyTo: message.replyTo,
    };
  }

  toViews(messages: MessageRecord[]): Promise<MessageView[]> {
    return Promise.all(messages.map((message) => this.toView(message)));
  }

  async markAudioPlayed(messageId: string, userId: string): Promise<MessageRecord | null> {
    const message = await this.repository.findById(messageId);
    if (!message || message.type !== 'audio' || message.senderId === userId || message.playedBy.includes(userId)) {
      return null;
    }

    return this.repository.update(messageId, { playedBy: [...message.playedBy, userId] });
  }

  private async resolveOnlineRecipients(participantIds: string[], senderId: string): Promise<string[]> {
    const others = participantIds.filter((id) => id !== senderId);
    const users = await Promise.all(others.map((id) => this.userService.getUser(id)));
    return users.filter((user): user is UserRecord => user !== null && user.status === 'online').map((user) => user.id);
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
      duration: original.duration,
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
