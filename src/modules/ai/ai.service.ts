import { logger } from '../../config/logger.js';
import type { AppServer } from '../../sockets/events.js';
import type { MessageRecord, MessageService, RoomPresenceService, TypingService } from '../messages/index.js';
import type { RoomKeyRepository, RoomRecord } from '../rooms/index.js';
import type { ObjectStorage } from '../../storage/object-storage.js';
import { guessMimeTypeFromUrl, loadDecryptedAttachment } from './ai.attachments.js';
import { decryptContent, encryptContent, unsealRoomKey } from './ai.crypto.js';
import type { AssistantIdentity } from './ai.identity.js';
import {
  AI_BATCH_DEBOUNCE_MS,
  AI_CONTEXT_MESSAGE_LIMIT,
  AI_MAX_AUDIO_SECONDS,
  AI_MAX_PDF_BYTES,
  AI_MAX_TEXT_CHARS,
  AI_MAX_TEXT_FILE_CHARS,
  AI_WELCOME_MESSAGE,
} from './ai.model.js';
import { compressImageForModel } from './ai.media.js';
import type { AiConversationMessage, AiRouter } from './ai.provider.js';
import type { AiUsageLimiter } from './ai.usage-limiter.js';

const ROOM_KEY_RETRY_DELAYS_MS = [0, 300, 700, 1200];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PendingBatch {
  messageIds: string[];
  senderId: string;
  timer: ReturnType<typeof setTimeout>;
}

export class AiService {
  private readonly pendingBatchByRoom = new Map<string, PendingBatch>();

  constructor(
    private readonly identity: AssistantIdentity,
    private readonly roomKeyRepository: RoomKeyRepository,
    private readonly messageService: MessageService,
    private readonly typingService: TypingService,
    private readonly presenceService: RoomPresenceService,
    private readonly router: AiRouter,
    private readonly usageLimiter: AiUsageLimiter,
    private readonly objectStorage: ObjectStorage,
  ) {}

  isAssistantRoom(room: RoomRecord): boolean {
    return room.type === 'private' && room.participants.includes(this.identity.userId);
  }

  async sendWelcomeMessage(io: AppServer, room: RoomRecord): Promise<void> {
    const roomKey = await this.resolveRoomKey(room.id);
    if (!roomKey) {
      logger.warn({ roomId: room.id }, 'Não foi possível enviar a mensagem de boas-vindas do SparkAI: chave da sala indisponível');
      return;
    }

    const encrypted = await encryptContent(AI_WELCOME_MESSAGE, roomKey);
    const message = await this.messageService.sendMessage({
      roomId: room.id,
      senderId: this.identity.userId,
      content: encrypted,
      type: 'text',
      participantIds: room.participants,
      viewingUserIds: this.presenceService.getViewers(room.id),
    });

    io.to(room.id).emit('message:new', await this.messageService.toView(message));
  }

  handleIncomingMessage(io: AppServer, room: RoomRecord, message: MessageRecord): void {
    void this.markAsReadByAssistant(io, room, [message.id]);

    const existing = this.pendingBatchByRoom.get(room.id);

    if (existing) {
      clearTimeout(existing.timer);
      existing.messageIds.push(message.id);
      existing.timer = setTimeout(() => this.flushBatch(io, room), AI_BATCH_DEBOUNCE_MS);
      return;
    }

    if (this.usageLimiter.isBlocked(message.senderId)) {
      void this.sendErrorMessage(io, room.id, 'Você atingiu o limite diário de mensagens com a IA. Tente novamente amanhã.');
      return;
    }

    this.broadcastTyping(io, room.id, true);
    this.pendingBatchByRoom.set(room.id, {
      messageIds: [message.id],
      senderId: message.senderId,
      timer: setTimeout(() => this.flushBatch(io, room), AI_BATCH_DEBOUNCE_MS),
    });
  }

  private async markAsReadByAssistant(io: AppServer, room: RoomRecord, messageIds: string[]): Promise<void> {
    try {
      await this.messageService.markRoomAsRead(room.id, this.identity.userId, messageIds);
      io.to(room.id).emit('message:read-receipt', { roomId: room.id, userId: this.identity.userId });
    } catch (error) {
      logger.error({ err: error, roomId: room.id }, 'Falha ao marcar mensagem como lida pelo SparkAI');
    }
  }

  private flushBatch(io: AppServer, room: RoomRecord): void {
    const batch = this.pendingBatchByRoom.get(room.id);
    if (!batch) {
      return;
    }

    this.pendingBatchByRoom.delete(room.id);
    void this.respondToBatch(io, room, batch);
  }

  private async respondToBatch(io: AppServer, room: RoomRecord, batch: PendingBatch): Promise<void> {
    try {
      const roomKey = await this.resolveRoomKey(room.id);
      if (!roomKey) {
        await this.sendErrorMessage(
          io,
          room.id,
          'Não foi possível preparar a conversa criptografada. Tente enviar a mensagem novamente em instantes.',
        );
        return;
      }

      const history = await this.buildConversation(room.id, roomKey, new Set(batch.messageIds));
      const replyText = await this.router.generateReply(history);
      const encryptedReply = await encryptContent(replyText, roomKey);

      const reply = await this.messageService.sendMessage({
        roomId: room.id,
        senderId: this.identity.userId,
        content: encryptedReply,
        type: 'text',
        participantIds: room.participants,
        viewingUserIds: this.presenceService.getViewers(room.id),
      });

      this.usageLimiter.registerUsage(batch.senderId);
      io.to(room.id).emit('message:new', await this.messageService.toView(reply));
    } catch (error) {
      logger.error({ err: error, roomId: room.id }, 'Falha ao gerar resposta da IA');
      await this.sendErrorMessage(io, room.id, 'Não consegui responder agora. Tente novamente em instantes.');
    } finally {
      this.broadcastTyping(io, room.id, false);
    }
  }

  private broadcastTyping(io: AppServer, roomId: string, isTyping: boolean): void {
    const users = isTyping
      ? this.typingService.startTyping(roomId, this.identity.userId)
      : this.typingService.stopTyping(roomId, this.identity.userId);
    io.to(roomId).emit('typing:update', { roomId, users });
  }

  private async sendErrorMessage(io: AppServer, roomId: string, content: string): Promise<void> {
    const message = await this.messageService.createErrorMessage(roomId, content);
    io.to(roomId).emit('message:new', await this.messageService.toView(message));
  }

  private async resolveRoomKey(roomId: string): Promise<Uint8Array | null> {
    for (const delayMs of ROOM_KEY_RETRY_DELAYS_MS) {
      if (delayMs > 0) {
        await delay(delayMs);
      }

      const sealedKey = await this.roomKeyRepository.findForUser(roomId, this.identity.userId);
      if (!sealedKey) {
        continue;
      }

      const unsealed = await unsealRoomKey(sealedKey, this.identity.publicKeyBytes, this.identity.privateKey);
      if (unsealed) {
        return unsealed;
      }
    }

    return null;
  }

  private async buildConversation(
    roomId: string,
    roomKey: Uint8Array,
    triggerMessageIds: Set<string>,
  ): Promise<AiConversationMessage[]> {
    const { messages } = await this.messageService.getRoomMessagesPage(roomId, { limit: AI_CONTEXT_MESSAGE_LIMIT });
    const conversation: AiConversationMessage[] = [];
    let mergedTrigger: AiConversationMessage | null = null;

    for (const message of messages) {
      if (message.deletedForEveryone || message.type === 'system' || message.type === 'error') {
        continue;
      }

      const role = message.senderId === this.identity.userId ? 'model' : 'user';

      if (triggerMessageIds.has(message.id)) {
        const part = await this.buildAttachedMessage(message, roomKey);
        mergedTrigger = this.mergeTriggerParts(mergedTrigger, part);
        continue;
      }

      if (message.type !== 'text') {
        conversation.push({ role, text: await this.describeAttachment(message, roomKey) });
        continue;
      }

      const plaintext = await decryptContent(message.content, roomKey);
      if (plaintext === null) {
        continue;
      }

      conversation.push({ role, text: this.truncateText(plaintext, AI_MAX_TEXT_CHARS) });
    }

    if (mergedTrigger) {
      conversation.push(mergedTrigger);
    }

    return conversation;
  }

  private mergeTriggerParts(existing: AiConversationMessage | null, next: AiConversationMessage): AiConversationMessage {
    if (!existing) {
      return next;
    }

    const mergedText = [existing.text, next.text].filter((value): value is string => Boolean(value)).join('\n');
    const inlineData = [...(existing.inlineData ?? []), ...(next.inlineData ?? [])];

    return mergedText ? { role: 'user', text: mergedText, inlineData } : { role: 'user', inlineData };
  }

  private buildInlineMessage(text: string | undefined, inlineData: NonNullable<AiConversationMessage['inlineData']>): AiConversationMessage {
    return text ? { role: 'user', text, inlineData } : { role: 'user', inlineData };
  }

  private truncateText(text: string, maxChars: number): string {
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }

  private async decryptFileName(message: MessageRecord, roomKey: Uint8Array): Promise<string> {
    if (!message.fileMeta) {
      return 'arquivo';
    }
    const name = await decryptContent(message.fileMeta.name, roomKey);
    return name ?? 'arquivo';
  }

  private async decryptFileMimeType(message: MessageRecord, roomKey: Uint8Array): Promise<string> {
    if (!message.fileMeta) {
      return '';
    }
    const mimeType = await decryptContent(message.fileMeta.mimeType, roomKey);
    return mimeType ?? '';
  }

  private async describeAttachment(message: MessageRecord, roomKey: Uint8Array): Promise<string> {
    const caption = message.caption ? await decryptContent(message.caption, roomKey) : null;
    const captionSuffix = caption ? ` com a legenda: "${this.truncateText(caption, AI_MAX_TEXT_CHARS)}"` : '';

    if (message.type === 'image') {
      return `[o usuário enviou uma imagem${captionSuffix}]`;
    }
    if (message.type === 'audio') {
      return `[o usuário enviou um áudio de ${message.duration ?? 0}s${captionSuffix}]`;
    }
    const name = await this.decryptFileName(message, roomKey);
    return `[o usuário enviou um arquivo: ${name}${captionSuffix}]`;
  }

  private async buildAttachedMessage(message: MessageRecord, roomKey: Uint8Array): Promise<AiConversationMessage> {
    const role = 'user' as const;
    const caption = message.caption ? await decryptContent(message.caption, roomKey) : null;
    const captionText = caption ? this.truncateText(caption, AI_MAX_TEXT_CHARS) : undefined;

    if (message.type === 'text') {
      const plaintext = await decryptContent(message.content, roomKey);
      return { role, text: plaintext !== null ? this.truncateText(plaintext, AI_MAX_TEXT_CHARS) : '[mensagem ilegível]' };
    }

    if (message.type === 'image') {
      const raw = await loadDecryptedAttachment(message.content, roomKey, this.objectStorage);
      if (!raw) {
        return { role, text: captionText ?? '[o usuário enviou uma imagem, mas não foi possível carregá-la]' };
      }
      const { mimeType, data } = await compressImageForModel(raw);
      return this.buildInlineMessage(captionText, [{ mimeType, data: data.toString('base64') }]);
    }

    if (message.type === 'audio') {
      if ((message.duration ?? 0) > AI_MAX_AUDIO_SECONDS) {
        return { role, text: `[o usuário enviou um áudio de ${message.duration}s, longo demais para eu ouvir agora]` };
      }
      const raw = await loadDecryptedAttachment(message.content, roomKey, this.objectStorage);
      const mimeType = guessMimeTypeFromUrl(message.content);
      if (!raw || !mimeType) {
        return { role, text: captionText ?? '[o usuário enviou um áudio, mas não foi possível carregá-lo]' };
      }
      return this.buildInlineMessage(captionText, [{ mimeType, data: raw.toString('base64') }]);
    }

    const [mimeType, name] = await Promise.all([
      this.decryptFileMimeType(message, roomKey),
      this.decryptFileName(message, roomKey),
    ]);

    if (mimeType === 'application/pdf') {
      if ((message.fileMeta?.size ?? 0) > AI_MAX_PDF_BYTES) {
        return { role, text: `[o usuário enviou o arquivo ${name}, grande demais para eu ler agora]` };
      }
      const raw = await loadDecryptedAttachment(message.content, roomKey, this.objectStorage);
      if (!raw) {
        return { role, text: captionText ?? `[o usuário enviou o arquivo ${name}, mas não foi possível carregá-lo]` };
      }
      return this.buildInlineMessage(captionText, [{ mimeType, data: raw.toString('base64') }]);
    }

    if (mimeType === 'text/plain' || mimeType === 'text/csv') {
      const raw = await loadDecryptedAttachment(message.content, roomKey, this.objectStorage);
      if (!raw) {
        return { role, text: captionText ?? `[o usuário enviou o arquivo ${name}, mas não foi possível carregá-lo]` };
      }
      const text = this.truncateText(raw.toString('utf8'), AI_MAX_TEXT_FILE_CHARS);
      const prefix = captionText ? `${captionText}\n\n` : '';
      return { role, text: `${prefix}Conteúdo do arquivo "${name}":\n${text}` };
    }

    const prefix = captionText ? `${captionText}\n\n` : '';
    return { role, text: `${prefix}[o usuário enviou o arquivo ${name}, formato não suportado para leitura]` };
  }
}
