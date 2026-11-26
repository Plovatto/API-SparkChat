import type { QuickReply } from '../assistant/assistant.card.js';
import type { SystemEvent } from './message.system-events.js';

export type MessageStatus = 'sent' | 'delivered' | 'read';

export type MessageType = 'text' | 'system' | 'image' | 'audio' | 'file' | 'error';

export interface MessageFileMeta {
  name: string;
  mimeType: string;
  size: number;
  thumbnailUrl?: string | undefined;
  key?: string | undefined;
  thumbnailKey?: string | undefined;
  previewKey?: string | undefined;
}

export interface MessageLinkPreview {
  url: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

export interface MessageSender {
  id: string;
  nickname: string;
  avatar: number | null;
  unknown?: true;
}

export interface MessageReplySnapshot {
  id: string;
  content: string;
  type: MessageType;
  duration: number | null;
  fileMeta: MessageFileMeta | null;
  caption: string | null;
  sender: MessageSender;
  deleted: boolean;
}

export interface MessageReaction {
  userId: string;
  emoji: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  roomId: string;
  senderId: string;
  content: string;
  type: MessageType;
  duration: number | null;
  timestamp: string;
  deletedForEveryone: boolean;
  status: MessageStatus;
  deliveredTo: string[];
  readBy: string[];
  playedBy: string[];
  replyTo: MessageReplySnapshot | null;
  mentionedUserIds: string[];
  fileMeta: MessageFileMeta | null;
  caption: string | null;
  linkPreview: MessageLinkPreview | null;
  systemEvent: SystemEvent | null;
  assistantCard?: string;
  quickReply?: QuickReply;
}

export interface MessageView {
  id: string;
  roomId: string;
  sender: MessageSender;
  content: string;
  type: MessageType;
  duration: number | null;
  timestamp: string;
  deletedForEveryone: boolean;
  status: MessageStatus;
  deliveredTo: string[];
  readBy: string[];
  playedBy: string[];
  replyTo: MessageReplySnapshot | null;
  mentionedUserIds: string[];
  fileMeta: MessageFileMeta | null;
  caption: string | null;
  linkPreview: MessageLinkPreview | null;
  systemEvent: SystemEvent | null;
  assistantCard?: string;
  quickReply?: QuickReply;
  reactions: MessageReaction[];
}
