import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  nickname: text('nickname').notNull(),
  nicknameNormalized: text('nickname_normalized').notNull().unique(),
  avatar: integer('avatar').notNull(),
  passwordHash: text('password_hash').notNull(),
  recoveryTokenHash: text('recovery_token_hash').notNull(),
  status: text('status').notNull().default('offline'),
  statusText: text('status_text'),
  createdAt: text('created_at').notNull(),
  lastSeen: text('last_seen').notNull(),
  themeBaseTheme: text('theme_base_theme'),
  themeColorTheme: text('theme_color_theme'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    authMethod: text('auth_method').notNull(),
    userAgent: text('user_agent').notNull(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at').notNull(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId)],
);

export const rooms = sqliteTable('rooms', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  name: text('name'),
  roomCode: text('room_code').unique(),
  createdBy: text('created_by').references(() => users.id),
  createdAt: text('created_at').notNull(),
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
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.userId] }),
    index('room_participants_user_id_idx').on(table.userId),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id').notNull(),
    senderId: text('sender_id').notNull(),
    content: text('content').notNull(),
    type: text('type').notNull(),
    duration: integer('duration'),
    timestamp: text('timestamp').notNull(),
    deletedForEveryone: integer('deleted_for_everyone', { mode: 'boolean' }).notNull().default(false),
    status: text('status').notNull().default('sent'),
    deliveredTo: text('delivered_to', { mode: 'json' }).$type<string[]>().notNull(),
    readBy: text('read_by', { mode: 'json' }).$type<string[]>().notNull(),
    playedBy: text('played_by', { mode: 'json' }).$type<string[]>().notNull(),
    replyToSnapshot: text('reply_to_snapshot', { mode: 'json' }),
    mentionedUserIds: text('mentioned_user_ids', { mode: 'json' }).$type<string[]>(),
  },
  (table) => [index('messages_room_id_timestamp_idx').on(table.roomId, table.timestamp)],
);
