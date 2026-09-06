import { and, asc, desc, eq, gt, inArray, lt, ne, not, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../database/turso-client.js';
import { messages } from '../../database/schema.js';
import type { MessageRecord, MessageReplySnapshot } from './message.types.js';

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

function normalizeReplySnapshot(snapshot: MessageReplySnapshot | null | undefined): MessageReplySnapshot | null {
  if (!snapshot) {
    return null;
  }
  return { ...snapshot, caption: snapshot.caption ?? null };
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

  async findByRoomId(roomId: string): Promise<MessageRecord[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.roomId, roomId))
      .orderBy(asc(messages.timestamp));

    return rows.map(toRecord);
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

  async findUnreadByRoomId(roomId: string, userId: string): Promise<MessageRecord[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.roomId, roomId), ne(messages.senderId, userId), not(jsonArrayContains(messages.readBy, userId))))
      .orderBy(asc(messages.timestamp));

    return rows.map(toRecord);
  }

  async findUndeliveredInRooms(roomIds: string[], userId: string): Promise<MessageRecord[]> {
    if (roomIds.length === 0) {
      return [];
    }

    const pages = await Promise.all(
      chunk(roomIds, MAX_IN_CLAUSE_IDS).map((ids) =>
        this.db
          .select()
          .from(messages)
          .where(
            and(
              inArray(messages.roomId, ids),
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
        .where(and(eq(messages.roomId, roomId), after ? gt(messages.timestamp, after) : undefined))
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
    options: { after?: string | undefined; before?: string | undefined; limit: number },
  ): Promise<{ messages: MessageRecord[]; hasMore: boolean }> {
    const conditions = [eq(messages.roomId, roomId)];
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
        ),
      );
  }
}
