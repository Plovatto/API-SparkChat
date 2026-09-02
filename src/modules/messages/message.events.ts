import type { MessageType, MessageView } from './message.types.js';

export interface MessageServerToClientEvents {
  'message:new': (payload: MessageView & { clientTempId?: string | undefined }) => void;
  'message:mark-read-done': (payload: { roomId: string; unreadCount: number }) => void;
  'message:read-receipt': (payload: { roomId: string; userId: string }) => void;
  'messages:list': (payload: { roomId: string; messages: MessageView[]; hasMore: boolean }) => void;
  'message:deleted': (payload: { messageId: string; roomId: string }) => void;
  'message:updated': (payload: MessageView) => void;
  'typing:update': (payload: { roomId: string; users: string[] }) => void;
  'recording:update': (payload: { roomId: string; users: string[] }) => void;
}

export interface MessageClientToServerEvents {
  'message:send': (payload: {
    roomId: string;
    content: string;
    type?: Extract<MessageType, 'text' | 'image' | 'audio'>;
    duration?: number;
    replyToMessageId?: string;
    clientTempId?: string | undefined;
  }) => void;
  'message:mark-read': (payload: { roomId: string; messageIds?: string[] }) => void;
  'messages:get': (payload: { roomId: string; before?: string; limit?: number }) => void;
  'message:delete': (payload: { messageId: string }) => void;
  'typing:start': (payload: { roomId: string }) => void;
  'typing:stop': (payload: { roomId: string }) => void;
  'recording:start': (payload: { roomId: string }) => void;
  'recording:stop': (payload: { roomId: string }) => void;
  'audio:played': (payload: { messageId: string }) => void;
  'room:view-start': (payload: { roomId: string }) => void;
  'room:view-stop': (payload: { roomId: string }) => void;
}
