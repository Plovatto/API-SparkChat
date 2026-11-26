import { and, asc, desc, eq, gt, inArray, lt, ne, not, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../database/turso-client.js';
import { assistantCardResolutions, messageHidden, messageReactions, messages } from '../../database/schema.js';
import type { QuickReplyChoice } from '../assistant/assistant.card.js';
import type { MessageReaction, MessageRecord, MessageReplySnapshot } from './message.types.js';

type MessageColumns = Partial<typeof messages.$inferInsert>;
type MessageRow = typeof messages.$inferSelect;
type JsonArrayColumn = typeof messages.readBy | typeof messages.deliveredTo | typeof messages.mentionedUserIds;

export interface RoomDigestRequest {
  roomId: string;
  after?: string | undefined;
}

export interface RoomDigest {
  lastMessage: MessageRecord | null;
  unreadCount: number;
  mentionCount: number;
}

export interface UnreadCounts {
  unreadCount: number;
  mentionCount: number;
}

const MAX_IN_CLAUSE_IDS = 500;
const MAX_CUTOFF_TERMS = 100;

export interface UnreadLookupOptions {
  after?: string | undefined;
  limit?: number | undefined;
}

function normalizeReplySnapshot(snapshot: MessageReplySnapshot | null | undefined): MessageReplySnapshot | null {
  if (!snapshot) {
    return null;
  }
  return { ...snapshot, caption: snapshot.caption ?? null, deleted: snapshot.deleted === true };
}

function toRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    roomId: row.roomId,
    senderId: row.senderId,
    content: row.content,
    type: row.type,
    duration: row.duration,
    timestamp: row.timestamp,
    deletedForEveryone: row.deletedForEveryone,
    status: row.status,
    deliveredTo: row.deliveredTo,
    readBy: row.readBy,
    playedBy: row.playedBy,
    replyTo: normalizeReplySnapshot(row.replyToSnapshot),
    mentionedUserIds: row.mentionedUserIds ?? [],
    fileMeta: row.fileMeta ?? null,
    caption: row.caption ?? null,
    linkPreview: row.linkPreview ?? null,
    systemEvent: row.systemEvent ?? null,
    ...(row.assistantCard ? { assistantCard: row.assistantCard } : {}),
    ...(row.quickReply ? { quickReply: row.quickReply } : {}),
  };
}

function toColumns(patch: Partial<MessageRecord>): MessageColumns {
  const { replyTo, ...rest } = patch;
  const columns: MessageColumns = { ...rest };
  if (replyTo !== undefined) {
    columns.replyToSnapshot = replyTo;
  }
  return columns;
}

function jsonArrayContains(column: JsonArrayColumn, value: string): SQL {
  return sql`exists (select 1 from json_each(${column}) where json_each.value = ${value})`;
}

function notHiddenFor(userId: string): SQL {
  return sql`not exists (select 1 from ${messageHidden} where ${messageHidden.userId} = ${userId} and ${messageHidden.messageId} = ${messages.id})`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export class MessageRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<MessageRecord | null> {
    const [row] = await this.db.select().from(messages).where(eq(messages.id, id));
    return row ? toRecord(row) : null;
  }

  async insert(message: MessageRecord): Promise<MessageRecord> {
    await this.db.insert(messages).values({
      id: message.id,
      roomId: message.roomId,
      senderId: message.senderId,
      content: message.content,
      type: message.type,
      duration: message.duration,
      timestamp: message.timestamp,
      deletedForEveryone: message.deletedForEveryone,
      status: message.status,
      deliveredTo: message.deliveredTo,
      readBy: message.readBy,
      playedBy: message.playedBy,
      replyToSnapshot: message.replyTo,
      mentionedUserIds: message.mentionedUserIds,
      fileMeta: message.fileMeta,
      caption: message.caption,
      linkPreview: message.linkPreview,
      systemEvent: message.systemEvent,
      assistantCard: message.assistantCard ?? null,
      quickReply: message.quickReply ?? null,
    });

    return message;
  }

  async update(id: string, patch: Partial<MessageRecord>): Promise<MessageRecord | null> {
    const columns = toColumns(patch);

    const [current] = await Promise.all([
      this.findById(id),
      Object.keys(columns).length > 0
        ? this.db.update(messages).set(columns).where(eq(messages.id, id))
        : Promise.resolve(),
    ]);

    return current ? { ...current, ...patch } : null;
  }

  async updateMany(updates: { id: string; patch: Partial<MessageRecord> }[]): Promise<void> {
    if (updates.length === 0) {
      return;
    }

    const statements = updates.map(({ id, patch }) =>
      this.db.update(messages).set(toColumns(patch)).where(eq(messages.id, id)),
    );

    if (statements.length === 1) {
      await statements[0];
      return;
    }

    await this.db.batch(statements as [(typeof statements)[number], ...(typeof statements)[number][]]);
  }

  async findDeletedIds(ids: string[]): Promise<Set<string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      return new Set();
    }

    const pages = await Promise.all(
      chunk(unique, MAX_IN_CLAUSE_IDS).map((batch) =>
        this.db
          .select({ id: messages.id })
          .from(messages)
          .where(and(inArray(messages.id, batch), eq(messages.deletedForEveryone, true))),
      ),
    );

    return new Set(pages.flat().map((row) => row.id));
  }

  async findReactions(messageIds: string[]): Promise<Map<string, MessageReaction[]>> {
    const unique = [...new Set(messageIds)];
    const reactions = new Map<string, MessageReaction[]>();
    if (unique.length === 0) {
      return reactions;
    }

    const pages = await Promise.all(
      chunk(unique, MAX_IN_CLAUSE_IDS).map((batch) =>
        this.db
          .select()
          .from(messageReactions)
          .where(inArray(messageReactions.messageId, batch))
          .orderBy(asc(messageReactions.updatedAt), asc(messageReactions.userId)),
      ),
    );

    for (const row of pages.flat()) {
      const reaction: MessageReaction = { userId: row.userId, emoji: row.emoji, updatedAt: row.updatedAt };
      const bucket = reactions.get(row.messageId);
      if (bucket) {
        bucket.push(reaction);
      } else {
        reactions.set(row.messageId, [reaction]);
      }
    }

    return reactions;
  }

  async findCardResolutions(cardIds: string[]): Promise<Map<string, QuickReplyChoice>> {
    const unique = [...new Set(cardIds)];
    const resolutions = new Map<string, QuickReplyChoice>();
    if (unique.length === 0) {
      return resolutions;
    }

    const pages = await Promise.all(
      chunk(unique, MAX_IN_CLAUSE_IDS).map((batch) =>
        this.db.select().from(assistantCardResolutions).where(inArray(assistantCardResolutions.cardMessageId, batch)),
      ),
    );
    for (const row of pages.flat()) {
      resolutions.set(row.cardMessageId, row.choice as QuickReplyChoice);
    }
    return resolutions;
  }

  async insertCardResolution(cardMessageId: string, userId: string, choice: QuickReplyChoice): Promise<boolean> {
    const inserted = await this.db
      .insert(assistantCardResolutions)
      .values({ cardMessageId, userId, choice, resolvedAt: new Date().toISOString() })
      .onConflictDoNothing()
      .returning({ cardMessageId: assistantCardResolutions.cardMessageId });
    return inserted.length > 0;
  }

  async upsertReaction(messageId: string, reaction: MessageReaction): Promise<void> {
    await this.db
      .insert(messageReactions)
      .values({ messageId, ...reaction })
      .onConflictDoUpdate({
        target: [messageReactions.messageId, messageReactions.userId],
        set: { emoji: reaction.emoji, updatedAt: reaction.updatedAt },
      });
  }

  async deleteReaction(messageId: string, userId: string): Promise<void> {
    await this.db
      .delete(messageReactions)
      .where(and(eq(messageReactions.messageId, messageId), eq(messageReactions.userId, userId)));
  }

  async deleteReactions(messageId: string): Promise<void> {
    await this.db.delete(messageReactions).where(eq(messageReactions.messageId, messageId));
  }

  async findRepliesTo(roomId: string, messageId: string): Promise<MessageRecord[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.roomId, roomId), sql`json_extract(${messages.replyToSnapshot}, '$.id') = ${messageId}`))
      .orderBy(asc(messages.timestamp));

    return rows.map(toRecord);
  }

  async findByRoomId(roomId: string): Promise<MessageRecord[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.roomId, roomId))
      .orderBy(asc(messages.timestamp));

    return rows.map(toRecord);
  }

  async findByIds(ids: string[]): Promise<MessageRecord[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      return [];
    }

    const pages = await Promise.all(
      chunk(unique, MAX_IN_CLAUSE_IDS).map((batch) => this.db.select().from(messages).where(inArray(messages.id, batch))),
    );

    return pages.flat().map(toRecord);
  }

  async findByRoomIdAndIds(roomId: string, ids: string[]): Promise<MessageRecord[]> {
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.roomId, roomId), inArray(messages.id, ids)))
      .orderBy(asc(messages.timestamp));

    return rows.map(toRecord);
  }

  async findUnreadByRoomId(roomId: string, userId: string, options: UnreadLookupOptions = {}): Promise<MessageRecord[]> {
    const query = this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.roomId, roomId),
          options.after ? gt(messages.timestamp, options.after) : undefined,
          ne(messages.senderId, userId),
          not(jsonArrayContains(messages.readBy, userId)),
        ),
      )
      .orderBy(asc(messages.timestamp));

    const rows = options.limit !== undefined ? await query.limit(options.limit) : await query;
    return rows.map(toRecord);
  }

  async findUndeliveredInRooms(requests: RoomDigestRequest[], userId: string): Promise<MessageRecord[]> {
    if (requests.length === 0) {
      return [];
    }

    const unrestricted = requests.filter((request) => !request.after).map((request) => request.roomId);
    const restricted = requests.filter((request): request is { roomId: string; after: string } => Boolean(request.after));
    const roomFilters: SQL[] = [
      ...chunk(unrestricted, MAX_IN_CLAUSE_IDS).map((ids) => inArray(messages.roomId, ids)),
      ...chunk(restricted, MAX_CUTOFF_TERMS).map(
        (group) =>
          or(...group.map((request) => and(eq(messages.roomId, request.roomId), gt(messages.timestamp, request.after)))) ?? sql`0`,
      ),
    ];

    const pages = await Promise.all(
      roomFilters.map((roomFilter) =>
        this.db
          .select()
          .from(messages)
          .where(
            and(
              roomFilter,
              ne(messages.senderId, userId),
              eq(messages.deletedForEveryone, false),
              not(jsonArrayContains(messages.deliveredTo, userId)),
              not(jsonArrayContains(messages.readBy, userId)),
            ),
          )
          .orderBy(asc(messages.timestamp)),
      ),
    );

    return pages.flat().map(toRecord);
  }

  async countUnread(roomId: string, userId: string, after?: string): Promise<UnreadCounts> {
    const [row] = await this.buildUnreadCountQuery(roomId, userId, after);
    return { unreadCount: row?.unreadCount ?? 0, mentionCount: row?.mentionCount ?? 0 };
  }

  async findRoomDigests(requests: RoomDigestRequest[], userId: string): Promise<Map<string, RoomDigest>> {
    const digests = new Map<string, RoomDigest>();
    if (requests.length === 0) {
      return digests;
    }

    const lastMessageQueries = requests.map(({ roomId, after }) =>
      this.db
        .select()
        .from(messages)
        .where(and(eq(messages.roomId, roomId), after ? gt(messages.timestamp, after) : undefined, notHiddenFor(userId)))
        .orderBy(desc(messages.timestamp))
        .limit(1),
    );
    const countQueries = requests.map(({ roomId, after }) => this.buildUnreadCountQuery(roomId, userId, after));

    const [lastMessageRows, countRows] = await Promise.all([
      this.db.batch(lastMessageQueries as [(typeof lastMessageQueries)[number], ...(typeof lastMessageQueries)[number][]]),
      this.db.batch(countQueries as [(typeof countQueries)[number], ...(typeof countQueries)[number][]]),
    ]);

    requests.forEach(({ roomId }, index) => {
      const lastRow = lastMessageRows[index]?.[0];
      const counts = countRows[index]?.[0];
      digests.set(roomId, {
        lastMessage: lastRow ? toRecord(lastRow) : null,
        unreadCount: counts?.unreadCount ?? 0,
        mentionCount: counts?.mentionCount ?? 0,
      });
    });

    return digests;
  }

  async findPageByRoomId(
    roomId: string,
    options: { after?: string | undefined; before?: string | undefined; limit: number; viewerId?: string | undefined },
  ): Promise<{ messages: MessageRecord[]; hasMore: boolean }> {
    const conditions = [eq(messages.roomId, roomId)];
    if (options.viewerId) {
      conditions.push(notHiddenFor(options.viewerId));
    }
    if (options.after) {
      conditions.push(gt(messages.timestamp, options.after));
    }
    if (options.before) {
      conditions.push(lt(messages.timestamp, options.before));
    }

    const rows = await this.db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.timestamp))
      .limit(options.limit + 1);

    const hasMore = rows.length > options.limit;
    const page = rows.slice(0, options.limit).reverse().map(toRecord);

    return { messages: page, hasMore };
  }

  private buildUnreadCountQuery(roomId: string, userId: string, after?: string) {
    return this.db
      .select({
        unreadCount: sql<number>`count(*)`.mapWith(Number),
        mentionCount: sql<number>`coalesce(sum(case when ${jsonArrayContains(messages.mentionedUserIds, userId)} then 1 else 0 end), 0)`.mapWith(Number),
      })
      .from(messages)
      .where(
        and(
          eq(messages.roomId, roomId),
          after ? gt(messages.timestamp, after) : undefined,
          ne(messages.senderId, userId),
          eq(messages.deletedForEveryone, false),
          not(jsonArrayContains(messages.readBy, userId)),
          notHiddenFor(userId),
        ),
      );
  }

  async hideForUser(userId: string, messageIds: string[], hiddenAt: string): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    await this.db
      .insert(messageHidden)
      .values(messageIds.map((messageId) => ({ userId, messageId, hiddenAt })))
      .onConflictDoNothing();
  }
}
