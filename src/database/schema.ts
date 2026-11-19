import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { LinkPreviewCacheRecord } from '../modules/link-preview/link-preview.types.js';
import type { SystemEvent } from '../modules/messages/message.system-events.js';
import type {
  MessageFileMeta,
  MessageLinkPreview,
  MessageReplySnapshot,
  MessageStatus,
  MessageType,
} from '../modules/messages/message.types.js';
import type { RoomType } from '../modules/rooms/room.types.js';
import type { AuthMethod, AuthVersion, UserChatSettings, UserStatus } from '../modules/users/user.model.js';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  nickname: text('nickname').notNull(),
  nicknameNormalized: text('nickname_normalized').notNull().unique(),
  avatar: integer('avatar').notNull(),
  passwordHash: text('password_hash').notNull(),
  recoveryTokenHash: text('recovery_token_hash').notNull(),
  status: text('status').$type<UserStatus>().notNull().default('offline'),
  statusText: text('status_text'),
  createdAt: text('created_at').notNull(),
  lastSeen: text('last_seen').notNull(),
  themeBaseTheme: text('theme_base_theme'),
  themeColorTheme: text('theme_color_theme'),
  chatSettings: text('chat_settings', { mode: 'json' }).$type<UserChatSettings>(),
  e2ePublicKey: text('e2e_public_key'),
  e2eSigningPublicKey: text('e2e_signing_public_key'),
  e2eKeySignature: text('e2e_key_signature'),
  e2eEncryptedPrivateKeyByPassword: text('e2e_encrypted_private_key_by_password'),
  e2eEncryptedPrivateKeyByRecovery: text('e2e_encrypted_private_key_by_recovery'),
  authSalt: text('auth_salt'),
  authVersion: integer('auth_version').$type<AuthVersion>().notNull().default(1),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    authMethod: text('auth_method').$type<AuthMethod>().notNull(),
    userAgent: text('user_agent').notNull(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at').notNull(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId)],
);

export const rooms = sqliteTable('rooms', {
  id: text('id').primaryKey(),
  type: text('type').$type<RoomType>().notNull(),
  name: text('name'),
  roomCode: text('room_code').unique(),
  createdBy: text('created_by').references(() => users.id),
  createdAt: text('created_at').notNull(),
  currentEpoch: integer('current_epoch').notNull().default(0),
  currentKeyId: text('current_key_id'),
  rotationRequired: integer('rotation_required'),
  inviteTokenHash: text('invite_token_hash'),
  encryptedInvite: text('encrypted_invite'),
  inviteKeyId: text('invite_key_id'),
  encryptedRoster: text('encrypted_roster'),
  rosterKeyId: text('roster_key_id'),
  encryptedName: text('encrypted_name'),
  nameKeyId: text('name_key_id'),
});

export const roomParticipants = sqliteTable(
  'room_participants',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    isVisible: integer('is_visible', { mode: 'boolean' }).notNull().default(true),
    isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
    blockedAt: text('blocked_at'),
    blockedByUserId: text('blocked_by_user_id'),
    deletedAt: text('deleted_at'),
    reactivatedAt: text('reactivated_at'),
    joinedAt: text('joined_at'),
    inviteProof: text('invite_proof'),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.userId] }),
    index('room_participants_user_id_idx').on(table.userId),
  ],
);

export const roomBans = sqliteTable(
  'room_bans',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bannedBy: text('banned_by'),
    bannedAt: text('banned_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.roomId, table.userId] })],
);

export const roomKeys = sqliteTable(
  'room_keys',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    keyId: text('key_id').notNull(),
    epoch: integer('epoch').notNull(),
    sealedKey: text('sealed_key').notNull(),
    senderId: text('sender_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.userId, table.keyId] }),
    index('room_keys_user_id_idx').on(table.userId),
  ],
);

export const roomRosters = sqliteTable(
  'room_rosters',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    keyId: text('key_id').notNull(),
    encryptedRoster: text('encrypted_roster').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.roomId, table.keyId] })],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id').notNull(),
    senderId: text('sender_id').notNull(),
    content: text('content').notNull(),
    type: text('type').$type<MessageType>().notNull(),
    duration: integer('duration'),
    timestamp: text('timestamp').notNull(),
    deletedForEveryone: integer('deleted_for_everyone', { mode: 'boolean' }).notNull().default(false),
    status: text('status').$type<MessageStatus>().notNull().default('sent'),
    deliveredTo: text('delivered_to', { mode: 'json' }).$type<string[]>().notNull(),
    readBy: text('read_by', { mode: 'json' }).$type<string[]>().notNull(),
    playedBy: text('played_by', { mode: 'json' }).$type<string[]>().notNull(),
    replyToSnapshot: text('reply_to_snapshot', { mode: 'json' }).$type<MessageReplySnapshot>(),
    mentionedUserIds: text('mentioned_user_ids', { mode: 'json' }).$type<string[]>(),
    fileMeta: text('file_meta', { mode: 'json' }).$type<MessageFileMeta>(),
    caption: text('caption'),
    linkPreview: text('link_preview', { mode: 'json' }).$type<MessageLinkPreview>(),
    systemEvent: text('system_event', { mode: 'json' }).$type<SystemEvent>(),
  },
  (table) => [index('messages_room_id_timestamp_idx').on(table.roomId, table.timestamp)],
);

export const uploads = sqliteTable(
  'uploads',
  {
    key: text('key').primaryKey(),
    uploaderId: text('uploader_id').notNull(),
    size: integer('size').notNull(),
    createdAt: text('created_at').notNull(),
    messageId: text('message_id'),
  },
  (table) => [
    index('uploads_uploader_id_idx').on(table.uploaderId),
    index('uploads_message_id_created_at_idx').on(table.messageId, table.createdAt),
  ],
);

export const storageUsage = sqliteTable('storage_usage', {
  id: text('id').primaryKey(),
  bytesUsed: integer('bytes_used').notNull().default(0),
});

export const linkPreviews = sqliteTable('link_previews', {
  cacheKey: text('url').primaryKey(),
  status: text('status').$type<LinkPreviewCacheRecord['status']>().notNull(),
  title: text('title'),
  description: text('description'),
  imageUrl: text('image_url'),
  siteName: text('site_name'),
  fetchedAt: text('fetched_at').notNull(),
});
