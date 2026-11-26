import { logger } from '../../config/logger.js';
import type { Locale } from '../../lib/locale.js';
import type { MessageRecord } from '../messages/index.js';
import type { RoomRecord } from '../rooms/index.js';
import type { AssistantReply } from './assistant.agent.js';
import type { AssistantCard, QuickReply, QuickReplyChoice } from './assistant.card.js';

export interface QuickReplyContext {
  userId: string;
  room: RoomRecord;
  card: AssistantCard;
  cardMessage: MessageRecord;
  choice: QuickReplyChoice;
  locale: Locale;
}

export type QuickReplyHandler = (context: QuickReplyContext) => Promise<AssistantReply | null>;

export class QuickReplyRegistry {
  private readonly handlers = new Map<AssistantCard['kind'], QuickReplyHandler>();

  registerQuickReplyHandler(kind: AssistantCard['kind'], handler: QuickReplyHandler): this {
    this.handlers.set(kind, handler);
    return this;
  }

  handlerFor(kind: AssistantCard['kind']): QuickReplyHandler | undefined {
    return this.handlers.get(kind);
  }
}

export interface QuickReplyDeps {
  assistantUserId: string;
  registry: QuickReplyRegistry;
  getMessage(messageId: string): Promise<MessageRecord | null>;
  openCard(message: MessageRecord): Promise<AssistantCard | null>;
  recordResolution(cardMessageId: string, userId: string, choice: QuickReplyChoice): Promise<boolean>;
  onResolved?(cardId: string, choice: QuickReplyChoice): void;
}

export interface QuickReplyInput {
  userId: string;
  room: RoomRecord;
  message: MessageRecord;
  quickReply: QuickReply;
  locale?: Locale;
}

export async function resolveQuickReply(deps: QuickReplyDeps, input: QuickReplyInput): Promise<AssistantReply | null> {
  const { userId, room, quickReply } = input;
  const cardMessage = await deps.getMessage(quickReply.cardId);
  if (
    !cardMessage ||
    cardMessage.roomId !== room.id ||
    cardMessage.senderId !== deps.assistantUserId ||
    cardMessage.deletedForEveryone ||
    !cardMessage.assistantCard
  ) {
    return null;
  }

  const card = await deps.openCard(cardMessage);
  if (!card) {
    return null;
  }

  const claimed = await deps.recordResolution(cardMessage.id, userId, quickReply.choice);
  if (!claimed) {
    return null;
  }
  deps.onResolved?.(cardMessage.id, quickReply.choice);

  if (quickReply.choice === 'another') {
    return null;
  }

  const handler = deps.registry.handlerFor(card.kind);
  if (!handler) {
    return null;
  }

  try {
    return await handler({ userId, room, card, cardMessage, choice: quickReply.choice, locale: input.locale ?? 'pt' });
  } catch (error) {
    logger.error({ err: error, roomId: room.id, kind: card.kind }, 'Falha ao tratar a resposta de botão do SparkAI');
    return null;
  }
}
