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
  releaseResolution(cardMessageId: string): Promise<void>;
  onResolved?(cardId: string, choice: QuickReplyChoice): void;
}

export interface QuickReplyInput {
  userId: string;
  room: RoomRecord;
  message: MessageRecord;
  quickReply: QuickReply;
  locale?: Locale;
}

export type QuickReplyOutcome =
  | { kind: 'reply'; reply: AssistantReply }
  | { kind: 'another' }
  | { kind: 'failed' }
  | { kind: 'ignored' };

const IGNORED: QuickReplyOutcome = { kind: 'ignored' };

function offersChoice(card: AssistantCard, choice: QuickReplyChoice): boolean {
  return 'buttons' in card && card.buttons.some((button) => button.choice === choice);
}

export async function resolveQuickReply(deps: QuickReplyDeps, input: QuickReplyInput): Promise<QuickReplyOutcome> {
  const { userId, room, quickReply } = input;
  const cardMessage = await deps.getMessage(quickReply.cardId);
  if (
    !cardMessage ||
    cardMessage.roomId !== room.id ||
    cardMessage.senderId !== deps.assistantUserId ||
    cardMessage.deletedForEveryone ||
    !cardMessage.assistantCard
  ) {
    return IGNORED;
  }

  const card = await deps.openCard(cardMessage);
  if (!card || !offersChoice(card, quickReply.choice)) {
    return IGNORED;
  }

  const claimed = await deps.recordResolution(cardMessage.id, userId, quickReply.choice);
  if (!claimed) {
    return IGNORED;
  }
  deps.onResolved?.(cardMessage.id, quickReply.choice);

  if (quickReply.choice === 'another') {
    return { kind: 'another' };
  }

  const handler = deps.registry.handlerFor(card.kind);
  if (!handler) {
    return IGNORED;
  }

  try {
    const reply = await handler({ userId, room, card, cardMessage, choice: quickReply.choice, locale: input.locale ?? 'pt' });
    return reply ? { kind: 'reply', reply } : IGNORED;
  } catch (error) {
    logger.error({ err: error, roomId: room.id, kind: card.kind }, 'Falha ao tratar a resposta de botão do SparkAI');
    await deps.releaseResolution(cardMessage.id);
    return { kind: 'failed' };
  }
}
