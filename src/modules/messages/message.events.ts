import type { QuickReplyChoice } from '../assistant/assistant.card.js';
import type { MessageFileMeta, MessageReaction, MessageType, MessageView } from './message.types.js';

export interface MessageServerToClientEvents {
  'message:new': (payload: MessageView & { clientTempId?: string | undefined }) => void;
  'message:mark-read-done': (payload: { roomId: string; unreadCount: number; mentionCount: number }) => void;
  'message:read-receipt': (payload: { roomId: string; userId: string }) => void;
  'messages:list': (payload: { roomId: string; messages: MessageView[]; hasMore: boolean }) => void;
  'message:deleted': (payload: { messageId: string; roomId: string }) => void;
  'message:hidden': (payload: {
    roomId: string;
    messageIds: string[];
    lastMessage: MessageView | null;
    unreadCount: number;
    mentionCount: number;
  }) => void;
  'message:updated': (payload: MessageView) => void;
  'message:reactions-updated': (payload: { roomId: string; messageId: string; messageTimestamp: string; reactions: MessageReaction[] }) => void;
  'message:card-resolved': (payload: { roomId: string; cardId: string; choice: QuickReplyChoice }) => void;
  'typing:update': (payload: { roomId: string; users: string[] }) => void;
  'recording:update': (payload: { roomId: string; users: string[] }) => void;
}

export interface MessageClientToServerEvents {
  'message:send': (payload: {
    roomId: string;
    content: string;
    type?: Extract<MessageType, 'text' | 'image' | 'audio' | 'file'>;
    duration?: number;
    replyToMessageId?: string;
    clientTempId?: string | undefined;
    fileMeta?: MessageFileMeta;
    mentionedUserIds?: string[];
    caption?: string;
  }) => void;
  'message:schedule': (payload: {
    cardId: string;
    roomId: string;
    sendAt: number;
    messageId: string;
    content: string;
    type: 'text';
    clientTempId?: string | undefined;
  }) => void;
  'message:unschedule': (payload: { id: string; clientTempId?: string | undefined }) => void;
  'message:mark-read': (payload: { roomId: string; messageIds?: string[] }) => void;
  'messages:get': (payload: { roomId: string; before?: string; limit?: number }) => void;
  'message:delete': (payload: { messageId: string } | { messageIds: string[] }) => void;
  'message:hide': (payload: { messageIds: string[] }) => void;
  'message:react': (payload: { messageId: string; emoji: string | null }) => void;
  'typing:start': (payload: { roomId: string }) => void;
  'typing:stop': (payload: { roomId: string }) => void;
  'recording:start': (payload: { roomId: string }) => void;
  'recording:stop': (payload: { roomId: string }) => void;
  'audio:played': (payload: { messageId: string }) => void;
  'room:view-start': (payload: { roomId: string }) => void;
  'room:view-stop': (payload: { roomId: string }) => void;
}
