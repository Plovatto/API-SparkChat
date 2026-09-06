export type MessageStatus = 'sent' | 'delivered' | 'read';

export type MessageType = 'text' | 'system' | 'image' | 'audio' | 'file' | 'error';

export interface MessageFileMeta {
  name: string;
  mimeType: string;
  size: number;
  thumbnailUrl?: string | undefined;
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
}

export interface MessageReplySnapshot {
  id: string;
  content: string;
  type: MessageType;
  duration: number | null;
  fileMeta: MessageFileMeta | null;
  caption: string | null;
  sender: MessageSender;
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
}
