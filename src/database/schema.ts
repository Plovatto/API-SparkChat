import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
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
  encryptedAvatar: text('encrypted_avatar'),
  avatarUploadKey: text('avatar_upload_key'),
  profileKeyVersion: integer('profile_key_version').notNull().default(1),
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
  rotationRequiredAt: text('rotation_required_at'),
  inviteTokenHash: text('invite_token_hash'),
  encryptedInvite: text('encrypted_invite'),
  inviteKeyId: text('invite_key_id'),
  encryptedRoster: text('encrypted_roster'),
  rosterKeyId: text('roster_key_id'),
  encryptedName: text('encrypted_name'),
  nameKeyId: text('name_key_id'),
  encryptedAvatar: text('encrypted_avatar'),
  avatarKeyId: text('avatar_key_id'),
  avatarUploadKey: text('avatar_upload_key'),
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
    profileKeyEnvelope: text('profile_key_envelope'),
    profileKeyKeyId: text('profile_key_key_id'),
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

export const roomKeyReports = sqliteTable(
  'room_key_reports',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    keyId: text('key_id').notNull(),
    senderId: text('sender_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.roomId, table.userId, table.keyId, table.senderId] })],
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

export const messageHidden = sqliteTable(
  'message_hidden',
  {
    userId: text('user_id').notNull(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    hiddenAt: text('hidden_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.messageId] }), index('message_hidden_message_id_idx').on(table.messageId)],
);

export const messageReactions = sqliteTable(
  'message_reactions',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    emoji: text('emoji').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.messageId, table.userId] })],
);

export const uploads = sqliteTable(
  'uploads',
  {
    key: text('key').primaryKey(),
    uploaderId: text('uploader_id').notNull(),
    size: integer('size').notNull(),
    createdAt: text('created_at').notNull(),
    messageId: text('message_id'),
    expiresAt: text('expires_at'),
    avatarOwner: text('avatar_owner'),
  },
  (table) => [
    index('uploads_uploader_id_idx').on(table.uploaderId),
    index('uploads_message_id_created_at_idx').on(table.messageId, table.createdAt),
    index('uploads_expires_at_idx').on(table.expiresAt),
    index('uploads_avatar_owner_idx').on(table.avatarOwner),
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

export const calls = sqliteTable(
  'calls',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id').notNull(),
    callerId: text('caller_id').notNull(),
    calleeId: text('callee_id').notNull(),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    createdAt: text('created_at').notNull(),
    answeredAt: text('answered_at'),
    endedAt: text('ended_at'),
    endReason: text('end_reason'),
    lastHeartbeatAt: text('last_heartbeat_at'),
    acceptedDeviceId: text('accepted_device_id'),
    relayUsed: integer('relay_used').notNull().default(0),
    turnUsername: text('turn_username'),
    calleeTurnUsername: text('callee_turn_username'),
    turnRevokedAt: text('turn_revoked_at'),
    callerRelayMs: integer('caller_relay_ms').notNull().default(0),
    calleeRelayMs: integer('callee_relay_ms').notNull().default(0),
    callerRelaySince: text('caller_relay_since'),
    calleeRelaySince: text('callee_relay_since'),
  },
  (table) => [
    index('calls_state_idx').on(table.state),
    index('calls_caller_id_idx').on(table.callerId),
    index('calls_callee_id_idx').on(table.calleeId),
  ],
);

export const callUsage = sqliteTable('call_usage', {
  month: text('month').primaryKey(),
  estimatedBytes: integer('estimated_bytes').notNull().default(0),
});

export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at').notNull(),
  },
  (table) => [index('push_subscriptions_user_id_idx').on(table.userId), index('push_subscriptions_session_id_idx').on(table.sessionId)],
);

export const transparencyLeaves = sqliteTable(
  'transparency_leaves',
  {
    position: integer('position').primaryKey(),
    leafId: text('leaf_id').notNull(),
    version: integer('version').notNull(),
    identityKey: text('identity_key').notNull(),
    signingKey: text('signing_key').notNull(),
    leafHash: text('leaf_hash').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('transparency_leaves_leaf_version_idx').on(table.leafId, table.version)],
);

export const transparencyNodes = sqliteTable(
  'transparency_nodes',
  {
    level: integer('level').notNull(),
    position: integer('position').notNull(),
    hash: text('hash').notNull(),
  },
  (table) => [primaryKey({ columns: [table.level, table.position] })],
);

export const transparencyMeta = sqliteTable('transparency_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const aiDailyUsage = sqliteTable(
  'ai_daily_usage',
  {
    userId: text('user_id').notNull(),
    usageDate: text('usage_date').notNull(),
    count: integer('count').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.userId, table.usageDate] }), index('ai_daily_usage_date_idx').on(table.usageDate)],
);
