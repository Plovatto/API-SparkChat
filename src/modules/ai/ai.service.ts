import { randomUUID } from 'node:crypto';
import { logger } from '../../config/logger.js';
import type { Locale } from '../../lib/locale.js';
import type { AppServer } from '../../sockets/events.js';
import {
  systemEvent,
  type MessageRecord,
  type MessageService,
  type RoomPresenceService,
  type SystemEventType,
  type TypingService,
} from '../messages/index.js';
import type { RoomKeyRepository, RoomRecord, RoomService } from '../rooms/index.js';
import type { UserService } from '../users/index.js';
import type { ObjectStorage } from '../../storage/object-storage.js';
import { loadDecryptedAttachment, resolveAudioMimeType } from './ai.attachments.js';
import { getSodium, openField, openRoomKeyEnvelope, readFieldKeyId, sealField } from './ai.crypto.js';
import { runAssistantTurn } from '../assistant/assistant.agent.js';
import type { AssistantReply } from '../assistant/assistant.agent.js';
import type { AssistantCard, ConfirmAction, QuickReplyChoice } from '../assistant/assistant.card.js';
import { HELP_SHORTCUTS, HELP_SHORTCUT_REPLY } from '../assistant/assistant.help-catalog.js';
import { anotherSuggestionInstruction, QUICK_REPLY_FAILED_TEXT } from '../assistant/assistant.prompt.js';
import { QuickReplyRegistry, resolveQuickReply } from '../assistant/assistant.quick-reply.js';
import { ASSISTANT_CARD_LABEL, sealAssistantCard } from '../assistant/assistant.seal.js';
import type { AssistantHost, VaultLabel } from '../assistant/assistant.host.js';
import { AssistantToolbox } from '../assistant/assistant.toolbox.js';
import type { AssistantIdentity } from './ai.identity.js';
import {
  AI_BATCH_DEBOUNCE_MS,
  AI_CONTEXT_MESSAGE_LIMIT,
  AI_MAX_AUDIO_BYTES,
  AI_MAX_AUDIO_SECONDS,
  AI_MAX_IMAGE_BYTES,
  AI_MAX_PDF_BYTES,
  AI_MAX_TEXT_CHARS,
  AI_MAX_TEXT_FILE_BYTES,
  AI_MAX_TEXT_FILE_CHARS,
  AI_NEWS_MESSAGES,
  AI_WELCOME_MESSAGES,
  ASSISTANT_NEWS_VERSION,
} from './ai.model.js';
import { compressImageForModel } from './ai.media.js';
import type { AiConversationMessage, AiRouter } from './ai.provider.js';
import type { AiUsageLimiter } from './ai.usage-limiter.js';

const ROOM_KEY_RETRY_DELAYS_MS = [0, 300, 700, 1200];
const MAX_CACHED_ROOM_KEYS = 1000;

const FIELD_LABELS = {
  content: 'content',
  caption: 'caption',
  fileName: 'file-name',
  fileMime: 'file-mime',
  fileKey: 'file-key',
  assistantCard: ASSISTANT_CARD_LABEL,
} as const;

type FieldLabel = (typeof FIELD_LABELS)[keyof typeof FIELD_LABELS];

interface CurrentRoomKey {
  keyId: string;
  roomKey: Uint8Array;
}

interface MessageReader {
  field(message: MessageRecord, value: string, label: FieldLabel): Promise<string | null>;
}
export const AI_PENDING_WELCOME_TTL_MS = 10 * 60 * 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PendingBatch {
  messageIds: string[];
  locale: Locale;
  timer: ReturnType<typeof setTimeout>;
}

export class AiService implements AssistantHost {
  private readonly pendingBatchByRoom = new Map<string, PendingBatch>();
  private readonly pendingWelcomeByRoom = new Map<string, { locale: Locale; timer: ReturnType<typeof setTimeout> }>();
  private readonly roomKeyCache = new Map<string, Uint8Array>();
  private readonly intakeByRoom = new Map<string, Promise<void>>();

  constructor(
    private readonly identity: AssistantIdentity,
    private readonly roomKeyRepository: RoomKeyRepository,
    private readonly messageService: MessageService,
    private readonly typingService: TypingService,
    private readonly presenceService: RoomPresenceService,
    private readonly router: AiRouter,
    private readonly usageLimiter: AiUsageLimiter,
    private readonly objectStorage: ObjectStorage,
    private readonly userService: Pick<UserService, 'getUsersByIds' | 'getTimeZone' | 'getAssistantNewsVersion' | 'claimAssistantNews' | 'releaseAssistantNews'>,
    private readonly toolbox: AssistantToolbox = new AssistantToolbox(),
    private readonly quickReplies: QuickReplyRegistry = new QuickReplyRegistry(),
    private readonly roomLookup: Pick<RoomService, 'findPrivateRoomBetween'> | null = null,
  ) {}

  isAssistantRoom(room: RoomRecord): boolean {
    return room.type === 'private' && room.participants.includes(this.identity.userId);
  }

  async seal(userId: string, label: VaultLabel, itemId: string, plaintext: string): Promise<string | null> {
    const room = await this.assistantRoomOf(userId);
    const roomKey = room ? await this.resolveRoomKey(room.id) : null;
    if (!room || !roomKey) {
      return null;
    }
    return sealField(plaintext, roomKey.roomKey, roomKey.keyId, this.identity.signingPrivateKey, {
      roomId: room.id,
      senderId: this.identity.userId,
      messageId: itemId,
      label,
    });
  }

  async open(userId: string, label: VaultLabel, itemId: string, sealed: string): Promise<string | null> {
    const room = await this.assistantRoomOf(userId);
    const keyId = readFieldKeyId(sealed);
    const roomKey = room && keyId ? await this.loadRoomKey(room.id, keyId) : null;
    if (!room || !roomKey) {
      return null;
    }
    return openField(sealed, roomKey, this.identity.signingPublicKeyBytes, {
      roomId: room.id,
      senderId: this.identity.userId,
      messageId: itemId,
      label,
    });
  }

  async roomIdOf(userId: string): Promise<string | null> {
    return (await this.assistantRoomOf(userId))?.id ?? null;
  }

  async post(io: AppServer, userId: string, reply: AssistantReply): Promise<void> {
    const room = await this.assistantRoomOf(userId);
    const roomKey = room ? await this.resolveRoomKey(room.id) : null;
    if (!room || !roomKey) {
      throw new Error('Sala do SparkAI indisponível para entregar a mensagem.');
    }
    await this.sendReply(io, room, roomKey, reply);
  }

  async openPendingConfirm(userId: string, cardId: string): Promise<{ roomId: string; action: ConfirmAction } | null> {
    const room = await this.assistantRoomOf(userId);
    const cardMessage = room ? await this.messageService.getMessage(cardId) : null;
    if (
      !room ||
      !cardMessage ||
      cardMessage.roomId !== room.id ||
      cardMessage.senderId !== this.identity.userId ||
      cardMessage.deletedForEveryone ||
      !cardMessage.assistantCard ||
      (await this.messageService.isCardResolved(cardId))
    ) {
      return null;
    }
    const card = await this.openCard(room.id, cardMessage);
    return card?.kind === 'confirm' ? { roomId: room.id, action: card.action } : null;
  }

  claimCard(cardId: string, userId: string, choice: QuickReplyChoice): Promise<boolean> {
    return this.messageService.recordCardResolution(cardId, userId, choice);
  }

  announceCardResolved(io: AppServer, roomId: string, cardId: string, choice: QuickReplyChoice): void {
    io.to(roomId).emit('message:card-resolved', { roomId, cardId, choice });
  }

  private async assistantRoomOf(userId: string): Promise<RoomRecord | null> {
    const room = (await this.roomLookup?.findPrivateRoomBetween(userId, this.identity.userId)) ?? null;
    return room && this.isAssistantRoom(room) ? room : null;
  }

  async sendWelcomeMessage(io: AppServer, room: RoomRecord, locale: Locale): Promise<void> {
    this.forgetPendingWelcome(room.id);
    try {
      const roomKey = await this.resolveRoomKey(room.id);
      if (!roomKey) {
        this.waitForRoomKey(room.id, locale);
        logger.info({ roomId: room.id }, 'Boas-vindas do SparkAI aguardando a chave da sala');
        return;
      }

      await this.deliverWelcome(io, room, locale, roomKey);
    } catch (error) {
      logger.error({ err: error, roomId: room.id }, 'Falha ao enviar a mensagem de boas-vindas do SparkAI');
    }
  }

  async handleRoomKeyPublished(io: AppServer, room: RoomRecord): Promise<void> {
    const pending = this.pendingWelcomeByRoom.get(room.id);
    if (!pending) {
      return;
    }
    this.forgetPendingWelcome(room.id);

    try {
      const roomKey = await this.resolveRoomKey(room.id);
      if (!roomKey) {
        this.waitForRoomKey(room.id, pending.locale);
        return;
      }
      await this.deliverWelcome(io, room, pending.locale, roomKey);
    } catch (error) {
      logger.error({ err: error, roomId: room.id }, 'Falha ao enviar a mensagem de boas-vindas do SparkAI');
    }
  }

  private forgetPendingWelcome(roomId: string): void {
    const pending = this.pendingWelcomeByRoom.get(roomId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingWelcomeByRoom.delete(roomId);
    }
  }

  private waitForRoomKey(roomId: string, locale: Locale): void {
    const previous = this.pendingWelcomeByRoom.get(roomId);
    if (previous) {
      clearTimeout(previous.timer);
    }
    const timer = setTimeout(() => {
      if (this.pendingWelcomeByRoom.get(roomId)?.timer === timer) {
        this.pendingWelcomeByRoom.delete(roomId);
      }
    }, AI_PENDING_WELCOME_TTL_MS);
    timer.unref?.();
    this.pendingWelcomeByRoom.set(roomId, { locale, timer });
  }

  private async deliverWelcome(io: AppServer, room: RoomRecord, locale: Locale, roomKey: CurrentRoomKey): Promise<void> {
    const messageId = randomUUID();
    const message = await this.messageService.sendMessage({
      roomId: room.id,
      senderId: this.identity.userId,
      messageId,
      content: await this.sealText(AI_WELCOME_MESSAGES[locale], roomKey, room.id, messageId),
      type: 'text',
      participantIds: room.participants,
      viewingUserIds: this.presenceService.getViewers(room.id),
      assistantCard: await sealAssistantCard(
        { v: 1, kind: 'capabilities' },
        roomKey,
        room.id,
        messageId,
        this.identity.signingPrivateKey,
        this.identity.userId,
      ),
    });

    io.to(room.id).emit('message:new', await this.messageService.toNewView(message));

    const memberId = room.participants.find((id) => id !== this.identity.userId);
    if (memberId) {
      await this.userService.claimAssistantNews(memberId, ASSISTANT_NEWS_VERSION).catch((error: unknown) => {
        logger.error({ err: error, userId: memberId }, 'Falha ao registrar a versão das novidades do SparkAI');
      });
    }
  }

  async deliverNewsIfDue(io: AppServer, userId: string, locale: Locale): Promise<void> {
    try {
      const seen = await this.userService.getAssistantNewsVersion(userId);
      if (seen !== null && seen >= ASSISTANT_NEWS_VERSION) {
        return;
      }
      const room = await this.assistantRoomOf(userId);
      const roomKey = room ? await this.resolveRoomKey(room.id, [0]) : null;
      if (!room || !roomKey) {
        return;
      }
      if (!(await this.userService.claimAssistantNews(userId, ASSISTANT_NEWS_VERSION))) {
        return;
      }
      try {
        await this.sendReply(io, room, roomKey, { text: AI_NEWS_MESSAGES[locale], card: { v: 1, kind: 'capabilities' } });
      } catch (error) {
        await this.userService.releaseAssistantNews(userId, ASSISTANT_NEWS_VERSION, seen).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      logger.error({ err: error, userId }, 'Falha ao enviar as novidades do SparkAI');
    }
  }

  handleIncomingMessage(io: AppServer, room: RoomRecord, message: MessageRecord, locale: Locale): Promise<void> {
    void this.markAsReadByAssistant(io, room, [message.id]);

    const previous = this.intakeByRoom.get(room.id) ?? Promise.resolve();
    const next = previous.then(() => this.admitMessage(io, room, message, locale));
    this.intakeByRoom.set(room.id, next);
    void next.then(() => {
      if (this.intakeByRoom.get(room.id) === next) {
        this.intakeByRoom.delete(room.id);
      }
    });
    return next;
  }

  private async admitMessage(io: AppServer, room: RoomRecord, message: MessageRecord, locale: Locale): Promise<void> {
    if (message.quickReply) {
      await this.handleQuickReply(io, room, message, message.quickReply, locale);
      return;
    }

    if (await this.answerHelpShortcut(io, room, message, locale)) {
      return;
    }

    let allowed: boolean;
    try {
      allowed = await this.usageLimiter.tryConsume(message.senderId);
    } catch (error) {
      logger.error({ err: error, roomId: room.id }, 'Falha ao registrar o uso diário do SparkAI');
      await this.sendErrorMessage(io, room.id, 'ai.replyFailed').catch(() => undefined);
      return;
    }

    if (!allowed) {
      await this.sendErrorMessage(io, room.id, 'ai.dailyLimitReached').catch(() => undefined);
      return;
    }

    const existing = this.pendingBatchByRoom.get(room.id);

    if (existing) {
      clearTimeout(existing.timer);
      existing.messageIds.push(message.id);
      existing.locale = locale;
      existing.timer = setTimeout(() => this.flushBatch(io, room), AI_BATCH_DEBOUNCE_MS);
      return;
    }

    this.broadcastTyping(io, room.id, true);
    this.pendingBatchByRoom.set(room.id, {
      messageIds: [message.id],
      locale,
      timer: setTimeout(() => this.flushBatch(io, room), AI_BATCH_DEBOUNCE_MS),
    });
  }

  private async answerHelpShortcut(io: AppServer, room: RoomRecord, message: MessageRecord, locale: Locale): Promise<boolean> {
    if (message.type !== 'text') {
      return false;
    }
    try {
      const reader = await this.createReader(room.id, [message]);
      const text = await reader.field(message, message.content, FIELD_LABELS.content);
      if (text === null || !HELP_SHORTCUTS.has(text.trim().toLowerCase())) {
        return false;
      }
    } catch (error) {
      logger.error({ err: error, roomId: room.id }, 'Falha ao ler o atalho de ajuda do SparkAI');
      return false;
    }
    try {
      const roomKey = await this.resolveRoomKey(room.id);
      if (!roomKey) {
        await this.sendErrorMessage(io, room.id, 'ai.encryptionUnavailable');
        return true;
      }
      await this.sendReply(io, room, roomKey, { text: HELP_SHORTCUT_REPLY[locale], card: { v: 1, kind: 'capabilities' } });
    } catch (error) {
      logger.error({ err: error, roomId: room.id }, 'Falha ao responder o atalho de ajuda do SparkAI');
    }
    return true;
  }

  private async handleQuickReply(
    io: AppServer,
    room: RoomRecord,
    message: MessageRecord,
    quickReply: NonNullable<MessageRecord['quickReply']>,
    locale: Locale,
  ): Promise<void> {
    try {
      const outcome = await resolveQuickReply(
        {
          assistantUserId: this.identity.userId,
          registry: this.quickReplies,
          getMessage: (id) => this.messageService.getMessage(id),
          openCard: (cardMessage) => this.openCard(room.id, cardMessage),
          recordResolution: (cardId, userId, choice) => this.messageService.recordCardResolution(cardId, userId, choice),
          releaseResolution: (cardId) => this.messageService.releaseCardResolution(cardId),
          beforeClaim: (choice) => this.consumeForAnotherSuggestion(io, room.id, message.senderId, choice),
          onResolved: (cardId, choice) => this.announceCardResolved(io, room.id, cardId, choice),
        },
        { io, userId: message.senderId, room, message, quickReply, locale },
      );

      if (outcome.kind === 'reply' || outcome.kind === 'failed') {
        const roomKey = await this.resolveRoomKey(room.id);
        if (!roomKey) {
          await this.sendErrorMessage(io, room.id, 'ai.encryptionUnavailable');
          return;
        }
        const reply = outcome.kind === 'reply' ? outcome.reply : { text: QUICK_REPLY_FAILED_TEXT[locale], card: null };
        await this.sendReply(io, room, roomKey, reply);
      } else if (outcome.kind === 'another') {
        this.requestAnotherSuggestion(io, room, message, locale, anotherSuggestionInstruction(locale, outcome.card), outcome.settle);
      }
    } catch (error) {
      logger.error({ err: error, roomId: room.id }, 'Falha ao resolver o botão do SparkAI');
      await this.sendErrorMessage(io, room.id, 'ai.replyFailed').catch(() => undefined);
    }
  }

  private async consumeForAnotherSuggestion(io: AppServer, roomId: string, userId: string, choice: QuickReplyChoice): Promise<boolean> {
    if (choice !== 'another' || (await this.usageLimiter.tryConsume(userId))) {
      return true;
    }
    await this.sendErrorMessage(io, roomId, 'ai.dailyLimitReached');
    return false;
  }

  private requestAnotherSuggestion(
    io: AppServer,
    room: RoomRecord,
    message: MessageRecord,
    locale: Locale,
    instruction: string,
    settle: (succeeded: boolean) => Promise<void>,
  ): void {
    this.broadcastTyping(io, room.id, true);
    void this.respondToBatch(io, room, { messageIds: [message.id], locale }, instruction)
      .then(settle)
      .catch((error: unknown) => logger.error({ err: error, roomId: room.id }, 'Falha ao concluir a outra sugestão do SparkAI'));
  }

  async openCard(roomId: string, cardMessage: MessageRecord): Promise<AssistantCard | null> {
    if (!cardMessage.assistantCard) {
      return null;
    }
    const reader = await this.createReader(roomId, [cardMessage]);
    const plaintext = await reader.field(cardMessage, cardMessage.assistantCard, FIELD_LABELS.assistantCard);
    if (plaintext === null) {
      return null;
    }
    try {
      const parsed = JSON.parse(plaintext) as AssistantCard;
      return typeof parsed?.kind === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  private async sendReply(io: AppServer, room: RoomRecord, roomKey: CurrentRoomKey, reply: AssistantReply): Promise<void> {
    const messageId = randomUUID();
    const sent = await this.messageService.sendMessage({
      roomId: room.id,
      senderId: this.identity.userId,
      messageId,
      content: await this.sealText(reply.text, roomKey, room.id, messageId),
      type: 'text',
      participantIds: room.participants,
      viewingUserIds: this.presenceService.getViewers(room.id),
      ...(reply.card ? { assistantCard: await sealAssistantCard(reply.card, roomKey, room.id, messageId, this.identity.signingPrivateKey, this.identity.userId) } : {}),
    });

    io.to(room.id).emit('message:new', await this.messageService.toNewView(sent));
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

  private async respondToBatch(
    io: AppServer,
    room: RoomRecord,
    batch: Pick<PendingBatch, 'messageIds' | 'locale'>,
    extraInstruction?: string,
  ): Promise<boolean> {
    try {
      const roomKey = await this.resolveRoomKey(room.id);
      if (!roomKey) {
        await this.sendErrorMessage(io, room.id, 'ai.encryptionUnavailable');
        return false;
      }

      const history = await this.buildConversation(room.id, new Set(batch.messageIds));
      const userId = room.participants.find((id) => id !== this.identity.userId);
      if (!userId) {
        throw new Error('Sala do SparkAI sem a outra pessoa.');
      }
      const reply = await runAssistantTurn({
        history,
        locale: batch.locale,
        context: {
          io,
          userId,
          roomId: room.id,
          locale: batch.locale,
          timeZone: await this.userService.getTimeZone(userId),
          now: Date.now(),
        },
        toolbox: this.toolbox,
        router: this.router,
        ...(extraInstruction ? { extraInstruction } : {}),
      });

      await this.sendReply(io, room, roomKey, reply);
      return true;
    } catch (error) {
      logger.error({ err: error, roomId: room.id }, 'Falha ao gerar resposta da IA');
      await this.sendErrorMessage(io, room.id, 'ai.replyFailed');
      return false;
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

  private async sendErrorMessage(
    io: AppServer,
    roomId: string,
    type: Extract<SystemEventType, `ai.${string}`>,
  ): Promise<void> {
    const message = await this.messageService.createErrorMessage(roomId, systemEvent(type));
    io.to(roomId).emit('message:new', await this.messageService.toNewView(message));
  }

  private sealText(text: string, roomKey: CurrentRoomKey, roomId: string, messageId: string): Promise<string> {
    return sealField(text, roomKey.roomKey, roomKey.keyId, this.identity.signingPrivateKey, {
      roomId,
      senderId: this.identity.userId,
      messageId,
      label: FIELD_LABELS.content,
    });
  }

  private async resolveRoomKey(roomId: string, delays: readonly number[] = ROOM_KEY_RETRY_DELAYS_MS): Promise<CurrentRoomKey | null> {
    for (const delayMs of delays) {
      if (delayMs > 0) {
        await delay(delayMs);
      }

      const state = await this.roomKeyRepository.getState(roomId);
      if (!state?.currentKeyId || state.rotationRequired !== null) {
        continue;
      }

      const roomKey = await this.loadRoomKey(roomId, state.currentKeyId);
      if (roomKey) {
        return { keyId: state.currentKeyId, roomKey };
      }
    }

    return null;
  }

  private async loadRoomKey(roomId: string, keyId: string): Promise<Uint8Array | null> {
    const cacheKey = `${roomId}:${keyId}`;
    const cached = this.roomKeyCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const stored = await this.roomKeyRepository.findForUser(roomId, this.identity.userId, keyId);
    if (!stored) {
      return null;
    }

    const roomKey = await openRoomKeyEnvelope({
      ...stored,
      recipientId: this.identity.userId,
      recipientPublicKey: this.identity.publicKey,
      recipientPrivateKey: this.identity.privateKey,
    });
    if (!roomKey) {
      logger.warn({ roomId, keyId, senderId: stored.senderId }, 'SparkAI descartou um envelope de chave de sala inválido');
      return null;
    }

    if (this.roomKeyCache.size >= MAX_CACHED_ROOM_KEYS) {
      const [oldest] = this.roomKeyCache.keys();
      if (oldest) {
        this.roomKeyCache.delete(oldest);
      }
    }
    this.roomKeyCache.set(cacheKey, roomKey);
    return roomKey;
  }

  private async createReader(roomId: string, messages: MessageRecord[]): Promise<MessageReader> {
    const senderIds = [...new Set(messages.map((message) => message.senderId))].filter((id) => id !== this.identity.userId);
    const usersById = await this.userService.getUsersByIds(senderIds);
    const sodium = await getSodium();
    const signingKeyOf = (senderId: string): Uint8Array | null => {
      if (senderId === this.identity.userId) {
        return this.identity.signingPublicKeyBytes;
      }
      const encoded = usersById.get(senderId)?.e2eSigningPublicKey;
      try {
        return encoded ? sodium.from_base64(encoded) : null;
      } catch {
        return null;
      }
    };
    const keyFor = (value: string): Promise<Uint8Array | null> => {
      const keyId = readFieldKeyId(value);
      return keyId ? this.loadRoomKey(roomId, keyId) : Promise.resolve(null);
    };

    return {
      field: async (message, value, label) => {
        const signingKey = signingKeyOf(message.senderId);
        const roomKey = signingKey ? await keyFor(value) : null;
        if (!roomKey || !signingKey) {
          return null;
        }
        return openField(value, roomKey, signingKey, { roomId, senderId: message.senderId, messageId: message.id, label });
      },
    };
  }

  private async buildConversation(roomId: string, triggerMessageIds: Set<string>): Promise<AiConversationMessage[]> {
    const { messages } = await this.messageService.getRoomMessagesPage(roomId, { limit: AI_CONTEXT_MESSAGE_LIMIT });
    const reader = await this.createReader(roomId, messages);
    const conversation: AiConversationMessage[] = [];
    let mergedTrigger: AiConversationMessage | null = null;

    for (const message of messages) {
      if (message.deletedForEveryone || message.type === 'system' || message.type === 'error') {
        continue;
      }

      const role = message.senderId === this.identity.userId ? 'model' : 'user';

      if (triggerMessageIds.has(message.id)) {
        const part = await this.buildAttachedMessage(message, reader);
        mergedTrigger = this.mergeTriggerParts(mergedTrigger, part);
        continue;
      }

      if (message.type !== 'text') {
        conversation.push({ role, text: await this.describeAttachment(message, reader) });
        continue;
      }

      const plaintext = await reader.field(message, message.content, FIELD_LABELS.content);
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

  private async decryptFileName(message: MessageRecord, reader: MessageReader): Promise<string> {
    if (!message.fileMeta) {
      return 'arquivo';
    }
    const name = await reader.field(message, message.fileMeta.name, FIELD_LABELS.fileName);
    return name ?? 'arquivo';
  }

  private async decryptFileMimeType(message: MessageRecord, reader: MessageReader): Promise<string> {
    if (!message.fileMeta) {
      return '';
    }
    const mimeType = await reader.field(message, message.fileMeta.mimeType, FIELD_LABELS.fileMime);
    return mimeType ?? '';
  }

  private async describeAttachment(message: MessageRecord, reader: MessageReader): Promise<string> {
    const caption = message.caption ? await reader.field(message, message.caption, FIELD_LABELS.caption) : null;
    const captionSuffix = caption ? ` com a legenda: "${this.truncateText(caption, AI_MAX_TEXT_CHARS)}"` : '';

    if (message.type === 'image') {
      return `[o usuário enviou uma imagem${captionSuffix}]`;
    }
    if (message.type === 'audio') {
      return `[o usuário enviou um áudio de ${message.duration ?? 0}s${captionSuffix}]`;
    }
    const name = await this.decryptFileName(message, reader);
    return `[o usuário enviou um arquivo: ${name}${captionSuffix}]`;
  }

  private async buildAttachedMessage(message: MessageRecord, reader: MessageReader): Promise<AiConversationMessage> {
    const role = 'user' as const;
    const caption = message.caption ? await reader.field(message, message.caption, FIELD_LABELS.caption) : null;
    const captionText = caption ? this.truncateText(caption, AI_MAX_TEXT_CHARS) : undefined;

    if (message.type === 'text') {
      const plaintext = await reader.field(message, message.content, FIELD_LABELS.content);
      return { role, text: plaintext !== null ? this.truncateText(plaintext, AI_MAX_TEXT_CHARS) : '[mensagem ilegível]' };
    }

    const fileKey = message.fileMeta?.key ? await reader.field(message, message.fileMeta.key, FIELD_LABELS.fileKey) : null;
    const binding = { roomId: message.roomId, messageId: message.id, slot: 'content' } as const;

    if (message.type === 'image') {
      const raw = await loadDecryptedAttachment(message.content, binding, fileKey, this.objectStorage, AI_MAX_IMAGE_BYTES);
      const compressed = raw ? await compressImageForModel(raw).catch(() => null) : null;
      if (!compressed) {
        return { role, text: captionText ?? '[o usuário enviou uma imagem, mas não foi possível carregá-la]' };
      }
      const { mimeType, data } = compressed;
      return this.buildInlineMessage(captionText, [{ mimeType, data: data.toString('base64') }]);
    }

    if (message.type === 'audio') {
      if ((message.duration ?? 0) > AI_MAX_AUDIO_SECONDS) {
        return { role, text: `[o usuário enviou um áudio de ${message.duration}s, longo demais para eu ouvir agora]` };
      }
      const [raw, declaredMimeType] = await Promise.all([
        loadDecryptedAttachment(message.content, binding, fileKey, this.objectStorage, AI_MAX_AUDIO_BYTES),
        message.fileMeta ? reader.field(message, message.fileMeta.mimeType, FIELD_LABELS.fileMime) : Promise.resolve(null),
      ]);
      const mimeType = resolveAudioMimeType(declaredMimeType, message.content);
      if (!raw || !mimeType) {
        return { role, text: captionText ?? '[o usuário enviou um áudio, mas não foi possível carregá-lo]' };
      }
      return this.buildInlineMessage(captionText, [{ mimeType, data: raw.toString('base64') }]);
    }

    const [mimeType, name] = await Promise.all([
      this.decryptFileMimeType(message, reader),
      this.decryptFileName(message, reader),
    ]);

    if (mimeType === 'application/pdf') {
      if ((message.fileMeta?.size ?? 0) > AI_MAX_PDF_BYTES) {
        return { role, text: `[o usuário enviou o arquivo ${name}, grande demais para eu ler agora]` };
      }
      const raw = await loadDecryptedAttachment(message.content, binding, fileKey, this.objectStorage, AI_MAX_PDF_BYTES);
      if (!raw) {
        return { role, text: captionText ?? `[o usuário enviou o arquivo ${name}, mas não foi possível carregá-lo]` };
      }
      return this.buildInlineMessage(captionText, [{ mimeType, data: raw.toString('base64') }]);
    }

    if (mimeType === 'text/plain' || mimeType === 'text/csv') {
      const raw = await loadDecryptedAttachment(message.content, binding, fileKey, this.objectStorage, AI_MAX_TEXT_FILE_BYTES);
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
