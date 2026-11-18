import { randomUUID } from 'node:crypto';
import { logger } from '../../config/logger.js';
import { AppError } from '../../lib/app-error.js';
import { resolveObjectKey } from '../../storage/object-storage-url.js';
import type { ObjectStorage } from '../../storage/object-storage.js';
import type { StorageQuota } from '../../storage/storage-quota.js';
import type { UploadRegistry } from '../../storage/upload-registry.js';
import type { UserService } from '../users/index.js';
import { nextTimestamp } from './message.clock.js';
import type { MessageRepository, RoomDigest, RoomDigestRequest, UnreadCounts } from './message.repository.js';

export const MARK_READ_BATCH_LIMIT = 500;
import { renderSystemEvent, type SystemEvent } from './message.system-events.js';
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
  attachmentUrls?: string[] | undefined;
}

export interface DeleteMessageResult {
  message: MessageRecord;
  affectedReplies: MessageRecord[];
}

const LEGACY_RELEASE_CAP_BYTES = 50 * 1024 * 1024;

const SYSTEM_SENDER_ID = 'system';
const SYSTEM_SENDER: MessageSender = { id: SYSTEM_SENDER_ID, nickname: 'Sistema', avatar: null };

function toDeletedReplySnapshot(snapshot: MessageReplySnapshot): MessageReplySnapshot {
  return {
    id: snapshot.id,
    content: '',
    type: snapshot.type,
    duration: null,
    fileMeta: null,
    caption: null,
    sender: snapshot.sender,
    deleted: true,
  };
}

export class MessageService {
  constructor(
    private readonly repository: MessageRepository,
    private readonly userService: UserService,
    private readonly objectStorage: ObjectStorage,
    private readonly storageQuota: StorageQuota,
    private readonly uploads: UploadRegistry,
  ) {}

  private resolveOwnedObjectKey(url: string): string {
    const key = resolveObjectKey(url);
    if (!key || url.split('?')[0] !== this.objectStorage.publicUrl(key)) {
      throw AppError.of('message.invalidMedia');
    }
    return key;
  }

  private attachmentKeysOf(input: SendMessageInput): string[] {
    const keys: string[] = [];
    if (input.type && input.type !== 'text') {
      keys.push(this.resolveOwnedObjectKey(input.content));
      if (input.fileMeta?.thumbnailUrl) {
        keys.push(this.resolveOwnedObjectKey(input.fileMeta.thumbnailUrl));
      }
    }
    for (const url of input.attachmentUrls ?? []) {
      keys.push(this.resolveOwnedObjectKey(url));
    }
    return [...new Set(keys)];
  }

  async sendMessage(input: SendMessageInput): Promise<MessageRecord> {
    const messageId = randomUUID();
    const attachmentKeys = this.attachmentKeysOf(input);
    if (!(await this.uploads.claim(attachmentKeys, input.senderId, messageId))) {
      throw AppError.of('message.invalidMedia');
    }

    try {
      return await this.insertMessage(messageId, input);
    } catch (error) {
      if (attachmentKeys.length > 0) {
        await this.uploads.release(messageId);
      }
      throw error;
    }
  }

  private async insertMessage(messageId: string, input: SendMessageInput): Promise<MessageRecord> {
    const deliveredTo = this.resolveOnlineRecipients(input.participantIds ?? [], input.senderId);
    const readBy = (input.viewingUserIds ?? []).filter(
      (userId) => userId !== input.senderId && deliveredTo.includes(userId),
    );

    const message: MessageRecord = {
      id: messageId,
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
      replyTo: input.replyToMessageId ? await this.buildReplySnapshot(input.replyToMessageId, input.roomId) : null,
      mentionedUserIds: input.mentionedUserIds ?? [],
      fileMeta: input.fileMeta ?? null,
      caption: input.type && input.type !== 'text' ? (input.caption ?? null) : null,
      linkPreview: input.linkPreview ?? null,
      systemEvent: null,
    };

    return this.repository.insert(message);
  }

  createSystemMessage(roomId: string, event: SystemEvent): Promise<MessageRecord> {
    return this.createSystemLikeMessage(roomId, event, 'system');
  }

  createErrorMessage(roomId: string, event: SystemEvent): Promise<MessageRecord> {
    return this.createSystemLikeMessage(roomId, event, 'error');
  }

  private createSystemLikeMessage(roomId: string, event: SystemEvent, type: Extract<MessageType, 'system' | 'error'>): Promise<MessageRecord> {
    const message: MessageRecord = {
      id: randomUUID(),
      roomId,
      senderId: SYSTEM_SENDER_ID,
      content: renderSystemEvent(event),
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
      systemEvent: event,
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

  countUnreadForUser(roomId: string, userId: string, after?: string): Promise<UnreadCounts> {
    return this.repository.countUnread(roomId, userId, after);
  }

  getMessage(messageId: string): Promise<MessageRecord | null> {
    return this.repository.findById(messageId);
  }

  async deleteMessage(messageId: string, requesterId: string): Promise<DeleteMessageResult> {
    const message = await this.repository.findById(messageId);
    if (!message) {
      throw AppError.of('message.notFound');
    }

    if (message.senderId !== requesterId) {
      throw AppError.of('message.deleteForbidden');
    }

    if (message.deletedForEveryone) {
      return { message, affectedReplies: [] };
    }

    const updated = await this.repository.update(messageId, {
      deletedForEveryone: true,
      content: '',
      fileMeta: null,
      caption: null,
      linkPreview: null,
      replyTo: null,
    });
    if (!updated) {
      throw AppError.of('message.notFound');
    }

    await this.deleteAttachmentObjects(message);
    const affectedReplies = await this.neutralizeRepliesTo(message.roomId, messageId);

    return { message: updated, affectedReplies };
  }

  private async neutralizeRepliesTo(roomId: string, messageId: string): Promise<MessageRecord[]> {
    const replies = await this.repository.findRepliesTo(roomId, messageId);
    const affected = replies
      .filter((reply): reply is MessageRecord & { replyTo: MessageReplySnapshot } => Boolean(reply.replyTo && !reply.replyTo.deleted))
      .map((reply) => ({ ...reply, replyTo: toDeletedReplySnapshot(reply.replyTo) }));

    await this.repository.updateMany(affected.map((reply) => ({ id: reply.id, patch: { replyTo: reply.replyTo } })));

    return affected;
  }

  private async deleteAttachmentObjects(message: MessageRecord): Promise<void> {
    const isMedia = message.type === 'image' || message.type === 'audio' || message.type === 'file';
    const urls = isMedia ? [message.content, message.fileMeta?.thumbnailUrl].filter((url): url is string => Boolean(url)) : [];
    let releasedBytes = 0;
    const handledKeys = new Set<string>();

    for (const extra of await this.uploads.findByMessage(message.id)) {
      handledKeys.add(extra.key);
      try {
        await this.objectStorage.deleteObject(extra.key);
        releasedBytes += extra.size;
        await this.uploads.remove(extra.key);
      } catch (error) {
        logger.error({ err: error, key: extra.key }, 'Failed to delete attachment object from storage');
      }
    }

    for (const url of urls) {
      const key = resolveObjectKey(url);
      if (!key || handledKeys.has(key)) {
        continue;
      }
      try {
        if (await this.uploads.find(key)) {
          continue;
        }

        await this.objectStorage.deleteObject(key);
        if (url === message.content) {
          releasedBytes += Math.min(message.fileMeta?.size ?? 0, LEGACY_RELEASE_CAP_BYTES);
        }
      } catch (error) {
        logger.error({ err: error, key }, 'Failed to delete attachment object from storage');
      }
    }

    if (releasedBytes > 0) {
      await this.storageQuota.releaseUsage(releasedBytes);
    }
  }

  async markRoomAsRead(roomId: string, userId: string, messageIds?: string[], after?: string): Promise<MessageRecord[]> {
    const messages =
      messageIds && messageIds.length > 0
        ? (await this.repository.findByRoomIdAndIds(roomId, messageIds)).filter((message) => !after || message.timestamp > after)
        : await this.repository.findUnreadByRoomId(roomId, userId, { after, limit: MARK_READ_BATCH_LIMIT });
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

  async markPendingMessagesDelivered(roomId: string, userId: string, after?: string): Promise<MessageRecord[]> {
    const deliveredByRoom = await this.markPendingMessagesDeliveredInRooms([{ roomId, after }], userId);
    return deliveredByRoom.get(roomId) ?? [];
  }

  async markPendingMessagesDeliveredInRooms(rooms: RoomDigestRequest[], userId: string): Promise<Map<string, MessageRecord[]>> {
    const deliveredByRoom = new Map<string, MessageRecord[]>();
    const pending = await this.repository.findUndeliveredInRooms(rooms, userId);
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

  async toView(message: MessageRecord, deletedReplyIds?: ReadonlySet<string>): Promise<MessageView> {
    const resolvedDeletedReplyIds = deletedReplyIds ?? (await this.findDeletedReplyIds([message]));

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
      replyTo: this.resolveReplyView(message, resolvedDeletedReplyIds),
      mentionedUserIds: message.mentionedUserIds,
      fileMeta: message.deletedForEveryone ? null : message.fileMeta,
      caption: message.deletedForEveryone ? null : message.caption,
      linkPreview: message.deletedForEveryone ? null : message.linkPreview,
      systemEvent: message.deletedForEveryone ? null : message.systemEvent,
    };
  }

  async toViews(messages: MessageRecord[]): Promise<MessageView[]> {
    const [deletedReplyIds] = await Promise.all([
      this.findDeletedReplyIds(messages),
      this.warmSenderProfiles(messages.map((message) => message.senderId)),
    ]);
    return Promise.all(messages.map((message) => this.toView(message, deletedReplyIds)));
  }

  private resolveReplyView(message: MessageRecord, deletedReplyIds: ReadonlySet<string>): MessageReplySnapshot | null {
    if (message.deletedForEveryone || !message.replyTo) {
      return null;
    }

    if (!message.replyTo.deleted && deletedReplyIds.has(message.replyTo.id)) {
      return toDeletedReplySnapshot(message.replyTo);
    }

    return message.replyTo;
  }

  private findDeletedReplyIds(messages: MessageRecord[]): Promise<Set<string>> {
    const replyIds: string[] = [];
    for (const message of messages) {
      if (!message.deletedForEveryone && message.replyTo && !message.replyTo.deleted) {
        replyIds.push(message.replyTo.id);
      }
    }

    return replyIds.length > 0 ? this.repository.findDeletedIds(replyIds) : Promise.resolve(new Set());
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

  private async buildReplySnapshot(messageId: string, roomId: string): Promise<MessageReplySnapshot | null> {
    const original = await this.repository.findById(messageId);
    if (!original || original.roomId !== roomId) {
      return null;
    }

    const snapshot: MessageReplySnapshot = {
      id: original.id,
      content: original.content,
      type: original.type,
      duration: original.duration,
      fileMeta: original.fileMeta,
      caption: original.caption,
      sender: await this.resolveSender(original.senderId),
      deleted: false,
    };

    return original.deletedForEveryone ? toDeletedReplySnapshot(snapshot) : snapshot;
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
      return { id: senderId, nickname: 'Usuário desconhecido', avatar: null, unknown: true };
    }

    return { id: user.id, nickname: user.nickname, avatar: user.avatar };
  }
}
