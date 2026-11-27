import { logger } from '../../config/logger.js';
import type { Locale } from '../../lib/locale.js';
import type { AppServer } from '../../sockets/events.js';
import type { MessageRecord } from '../messages/index.js';
import type { RoomRecord } from '../rooms/index.js';
import type { AssistantReply } from './assistant.agent.js';
import type { AssistantCard, QuickReply, QuickReplyChoice } from './assistant.card.js';

export interface QuickReplyContext {
  io: AppServer;
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
  beforeClaim?(choice: QuickReplyChoice): Promise<boolean>;
  onResolved?(cardId: string, choice: QuickReplyChoice): void;
}

export interface QuickReplyInput {
  io: AppServer;
  userId: string;
  room: RoomRecord;
  message: MessageRecord;
  quickReply: QuickReply;
  locale?: Locale;
}

export type QuickReplyOutcome =
  | { kind: 'reply'; reply: AssistantReply }
  | { kind: 'another'; card: AssistantCard; settle: (succeeded: boolean) => Promise<void> }
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

  if (quickReply.choice === 'yes' && card.kind === 'confirm' && card.action.type === 'scheduled-message') {
    return IGNORED;
  }

  if (deps.beforeClaim && !(await deps.beforeClaim(quickReply.choice))) {
    return IGNORED;
  }

  const claimed = await deps.recordResolution(cardMessage.id, userId, quickReply.choice);
  if (!claimed) {
    return IGNORED;
  }
  const announce = (): void => deps.onResolved?.(cardMessage.id, quickReply.choice);

  if (quickReply.choice === 'another') {
    return {
      kind: 'another',
      card,
      settle: async (succeeded) => {
        if (succeeded) {
          announce();
          return;
        }
        await deps.releaseResolution(cardMessage.id);
      },
    };
  }

  const handler = deps.registry.handlerFor(card.kind);
  if (!handler) {
    announce();
    return IGNORED;
  }

  try {
    const reply = await handler({ io: input.io, userId, room, card, cardMessage, choice: quickReply.choice, locale: input.locale ?? 'pt' });
    announce();
    return reply ? { kind: 'reply', reply } : IGNORED;
  } catch (error) {
    logger.error({ err: error, roomId: room.id, kind: card.kind }, 'Falha ao tratar a resposta de botão do SparkAI');
    await deps.releaseResolution(cardMessage.id);
    return { kind: 'failed' };
  }
}
