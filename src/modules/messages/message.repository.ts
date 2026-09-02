import { and, asc, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import type { Database } from '../../database/turso-client.js';
import { messages } from '../../database/schema.js';
import type { MessageRecord, MessageReplySnapshot, MessageStatus, MessageType } from './message.types.js';

function toRecord(row: typeof messages.$inferSelect): MessageRecord {
  return {
    id: row.id,
    roomId: row.roomId,
    senderId: row.senderId,
    content: row.content,
    type: row.type as MessageType,
    duration: row.duration,
    timestamp: row.timestamp,
    deletedForEveryone: row.deletedForEveryone,
    status: row.status as MessageStatus,
    deliveredTo: row.deliveredTo,
    readBy: row.readBy,
    playedBy: row.playedBy,
    replyTo: (row.replyToSnapshot as MessageReplySnapshot | null) ?? null,
  };
}

function isSameMessage(a: MessageRecord, b: MessageRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class MessageRepository {
  constructor(private readonly db: Database) {}

  async findAll(): Promise<MessageRecord[]> {
    const rows = await this.db.select().from(messages);
    return rows.map(toRecord);
  }

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
    });

    return message;
  }

  async update(id: string, patch: Partial<MessageRecord>): Promise<MessageRecord | null> {
    const { replyTo, ...rest } = patch;
    const columns: Partial<typeof messages.$inferInsert> = { ...rest };
    if (replyTo !== undefined) {
      columns.replyToSnapshot = replyTo;
    }

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

    const statements = updates.map(({ id, patch }) => {
      const { replyTo, ...rest } = patch;
      const columns: Partial<typeof messages.$inferInsert> = { ...rest };
      if (replyTo !== undefined) {
        columns.replyToSnapshot = replyTo;
      }
      return this.db.update(messages).set(columns).where(eq(messages.id, id));
    });

    if (statements.length === 1) {
      await statements[0];
      return;
    }

    await this.db.batch(statements as [(typeof statements)[number], ...(typeof statements)[number][]]);
  }

  async replaceAll(items: MessageRecord[]): Promise<void> {
    const current = await this.findAll();
    const currentById = new Map(current.map((message) => [message.id, message]));

    const changed = items.filter((item) => {
      const existing = currentById.get(item.id);
      return !(existing && isSameMessage(existing, item));
    });

    await Promise.all(changed.map((item) => this.update(item.id, item)));
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
