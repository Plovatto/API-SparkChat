import { and, asc, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import type { Database } from '../../database/turso-client.js';
import { messages } from '../../database/schema.js';
import type { MessageRecord, MessageReplySnapshot } from './message.types.js';

type MessageColumns = Partial<typeof messages.$inferInsert>;

function normalizeReplySnapshot(snapshot: MessageReplySnapshot | null | undefined): MessageReplySnapshot | null {
  if (!snapshot) {
    return null;
  }
  return { ...snapshot, caption: snapshot.caption ?? null };
}

function toRecord(row: typeof messages.$inferSelect): MessageRecord {
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
}
