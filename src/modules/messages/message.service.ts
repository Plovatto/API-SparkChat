import { randomUUID } from 'node:crypto';
import type { UserService } from '../users/index.js';
import { nextTimestamp } from './message.clock.js';
import type { MessageRepository, RoomDigest, RoomDigestRequest, UnreadCounts } from './message.repository.js';
import type {
  MessageFileMeta,
  MessageLinkPreview,
  MessageRecord,
  MessageReplySnapshot,
  MessageSender,
  MessageType,
  MessageView,
} from './message.types.js';

export interface SendMessageInput {
  roomId: string;
  senderId: string;
  content: string;
  type?: Extract<MessageType, 'text' | 'image' | 'audio' | 'file'> | undefined;
  duration?: number | undefined;
  replyToMessageId?: string | undefined;
  participantIds?: string[] | undefined;
  viewingUserIds?: string[] | undefined;
  mentionedUserIds?: string[] | undefined;
  fileMeta?: MessageFileMeta | null | undefined;
  caption?: string | null | undefined;
  linkPreview?: MessageLinkPreview | null | undefined;
}

const SYSTEM_SENDER_ID = 'system';
const SYSTEM_SENDER: MessageSender = { id: SYSTEM_SENDER_ID, nickname: 'Sistema', avatar: null };

export class MessageService {
  constructor(
    private readonly repository: MessageRepository,
    private readonly userService: UserService,
  ) {}

  async sendMessage(input: SendMessageInput): Promise<MessageRecord> {
    const deliveredTo = this.resolveOnlineRecipients(input.participantIds ?? [], input.senderId);
    const readBy = (input.viewingUserIds ?? []).filter(
      (userId) => userId !== input.senderId && deliveredTo.includes(userId),
    );

    const message: MessageRecord = {
      id: randomUUID(),
      roomId: input.roomId,
      senderId: input.senderId,
      content: input.content,
      type: input.type ?? 'text',
      duration: input.type === 'audio' ? (input.duration ?? null) : null,
      timestamp: nextTimestamp(input.roomId),
      deletedForEveryone: false,
      status: readBy.length > 0 ? 'read' : deliveredTo.length > 0 ? 'delivered' : 'sent',
      deliveredTo,
      readBy,
      playedBy: [],
      replyTo: input.replyToMessageId ? await this.buildReplySnapshot(input.replyToMessageId) : null,
      mentionedUserIds: input.mentionedUserIds ?? [],
      fileMeta: input.fileMeta ?? null,
      caption: input.type && input.type !== 'text' ? (input.caption ?? null) : null,
      linkPreview: input.linkPreview ?? null,
    };

    return this.repository.insert(message);
  }

  createSystemMessage(roomId: string, content: string): Promise<MessageRecord> {
    return this.createSystemLikeMessage(roomId, content, 'system');
  }

  createErrorMessage(roomId: string, content: string): Promise<MessageRecord> {
    return this.createSystemLikeMessage(roomId, content, 'error');
  }

  private createSystemLikeMessage(roomId: string, content: string, type: Extract<MessageType, 'system' | 'error'>): Promise<MessageRecord> {
    const message: MessageRecord = {
      id: randomUUID(),
      roomId,
      senderId: SYSTEM_SENDER_ID,
      content,
      type,
      duration: null,
      timestamp: nextTimestamp(roomId),
      deletedForEveryone: false,
      status: 'sent',
      deliveredTo: [],
      readBy: [],
      playedBy: [],
      replyTo: null,
      mentionedUserIds: [],
      fileMeta: null,
      caption: null,
      linkPreview: null,
    };

    return this.repository.insert(message);
  }

  getRoomMessages(roomId: string): Promise<MessageRecord[]> {
    return this.repository.findByRoomId(roomId);
  }

  getRoomMessagesPage(
    roomId: string,
    options: { after?: string | undefined; before?: string | undefined; limit: number },
  ): Promise<{ messages: MessageRecord[]; hasMore: boolean }> {
    return this.repository.findPageByRoomId(roomId, options);
  }

  getRoomDigests(requests: RoomDigestRequest[], userId: string): Promise<Map<string, RoomDigest>> {
    return this.repository.findRoomDigests(requests, userId);
  }

  countUnreadForUser(roomId: string, userId: string): Promise<UnreadCounts> {
    return this.repository.countUnread(roomId, userId);
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

  async markRoomAsRead(roomId: string, userId: string, messageIds?: string[]): Promise<MessageRecord[]> {
    const messages =
      messageIds && messageIds.length > 0
        ? await this.repository.findByRoomIdAndIds(roomId, messageIds)
        : await this.repository.findUnreadByRoomId(roomId, userId);
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

    await this.repository.updateMany(
      updated
        .filter((message, index) => message !== messages[index])
        .map((message) => ({
          id: message.id,
          patch: { deliveredTo: message.deliveredTo, readBy: message.readBy, status: message.status },
        })),
    );

    return updated;
  }

  async markPendingMessagesDelivered(roomId: string, userId: string): Promise<MessageRecord[]> {
    const deliveredByRoom = await this.markPendingMessagesDeliveredInRooms([roomId], userId);
    return deliveredByRoom.get(roomId) ?? [];
  }

  async markPendingMessagesDeliveredInRooms(roomIds: string[], userId: string): Promise<Map<string, MessageRecord[]>> {
    const deliveredByRoom = new Map<string, MessageRecord[]>();
    const pending = await this.repository.findUndeliveredInRooms(roomIds, userId);
    if (pending.length === 0) {
      return deliveredByRoom;
    }

    const updated = pending.map((message) => ({
      ...message,
      deliveredTo: [...message.deliveredTo, userId],
      status: message.status === 'read' ? message.status : ('delivered' as const),
    }));

    await this.repository.updateMany(
      updated.map((message) => ({
        id: message.id,
        patch: { deliveredTo: message.deliveredTo, status: message.status },
      })),
    );

    for (const message of updated) {
      const bucket = deliveredByRoom.get(message.roomId);
      if (bucket) {
        bucket.push(message);
      } else {
        deliveredByRoom.set(message.roomId, [message]);
      }
    }

    return deliveredByRoom;
  }

  countUnread(messages: MessageRecord[], userId: string): number {
    return messages.filter(
      (message) => message.senderId !== userId && !message.deletedForEveryone && !message.readBy.includes(userId),
    ).length;
  }

  countUnreadMentions(messages: MessageRecord[], userId: string): number {
    return messages.filter(
      (message) =>
        message.senderId !== userId &&
        !message.deletedForEveryone &&
        !message.readBy.includes(userId) &&
        message.mentionedUserIds.includes(userId),
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
      mentionedUserIds: message.mentionedUserIds,
      fileMeta: message.deletedForEveryone ? null : message.fileMeta,
      caption: message.deletedForEveryone ? null : message.caption,
      linkPreview: message.deletedForEveryone ? null : message.linkPreview,
    };
  }

  async toViews(messages: MessageRecord[]): Promise<MessageView[]> {
    await this.warmSenderProfiles(messages.map((message) => message.senderId));
    return Promise.all(messages.map((message) => this.toView(message)));
  }

  async markAudioPlayed(messageId: string, userId: string): Promise<MessageRecord | null> {
    const message = await this.repository.findById(messageId);
    if (!message || message.type !== 'audio' || message.senderId === userId || message.playedBy.includes(userId)) {
      return null;
    }

    return this.repository.update(messageId, { playedBy: [...message.playedBy, userId] });
  }

  private async warmSenderProfiles(senderIds: string[]): Promise<void> {
    const missing = new Set<string>();
    for (const senderId of senderIds) {
      if (senderId !== SYSTEM_SENDER_ID && !this.userService.getCachedProfile(senderId)) {
        missing.add(senderId);
      }
    }

    if (missing.size > 0) {
      await this.userService.getUsersByIds([...missing]);
    }
  }

  private resolveOnlineRecipients(participantIds: string[], senderId: string): string[] {
    return participantIds.filter((id) => id !== senderId && this.userService.isOnline(id));
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
      fileMeta: original.fileMeta,
      caption: original.caption,
      sender: await this.resolveSender(original.senderId),
    };
  }

  private async resolveSender(senderId: string): Promise<MessageSender> {
    if (senderId === SYSTEM_SENDER_ID) {
      return SYSTEM_SENDER;
    }

    const cached = this.userService.getCachedProfile(senderId);
    if (cached) {
      return { id: cached.id, nickname: cached.nickname, avatar: cached.avatar };
    }

    const user = await this.userService.getUser(senderId);
    if (!user) {
      return { id: senderId, nickname: 'Usuário desconhecido', avatar: null };
    }

    return { id: user.id, nickname: user.nickname, avatar: user.avatar };
  }
}
