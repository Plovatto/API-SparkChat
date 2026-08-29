export type MessageStatus = 'sent' | 'delivered' | 'read';

export type MessageType = 'text' | 'system';

export interface MessageSender {
  id: string;
  nickname: string;
  avatar: number | null;
}

export interface MessageReplySnapshot {
  id: string;
  content: string;
  type: MessageType;
  sender: MessageSender;
}

export interface MessageRecord {
  id: string;
  roomId: string;
  senderId: string;
  content: string;
  type: MessageType;
  timestamp: string;
  deletedForEveryone: boolean;
  status: MessageStatus;
  deliveredTo: string[];
  readBy: string[];
  replyTo: MessageReplySnapshot | null;
}

export interface MessageView {
  id: string;
  roomId: string;
  sender: MessageSender;
  content: string;
  type: MessageType;
  timestamp: string;
  deletedForEveryone: boolean;
  status: MessageStatus;
  deliveredTo: string[];
  readBy: string[];
  replyTo: MessageReplySnapshot | null;
}
