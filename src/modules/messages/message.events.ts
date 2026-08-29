import type { MessageView } from './message.types.js';

export interface MessageServerToClientEvents {
  'message:new': (payload: MessageView) => void;
  'message:mark-read-done': (payload: { roomId: string; unreadCount: number }) => void;
  'message:read-receipt': (payload: { roomId: string; userId: string }) => void;
  'messages:list': (payload: { roomId: string; messages: MessageView[] }) => void;
  'message:deleted': (payload: { messageId: string; roomId: string }) => void;
}

export interface MessageClientToServerEvents {
  'message:send': (payload: { roomId: string; content: string }) => void;
  'message:mark-read': (payload: { roomId: string }) => void;
  'messages:get': (payload: { roomId: string }) => void;
  'message:delete': (payload: { messageId: string }) => void;
}
