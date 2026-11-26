import { and, count, desc, eq, sql } from 'drizzle-orm';
import { assistantNotes } from '../../database/schema.js';
import type { Database } from '../../database/turso-client.js';

export interface NoteRow {
  id: string;
  userId: string;
  contentSealed: string;
  createdAt: number;
}

export class NotesRepository {
  constructor(private readonly db: Database) {}

  async insertIfBelow(row: NoteRow, limit: number): Promise<boolean> {
    const result = await this.db.run(sql`
      INSERT INTO assistant_notes (id, user_id, content_sealed, created_at)
      SELECT ${row.id}, ${row.userId}, ${row.contentSealed}, ${row.createdAt}
      WHERE (SELECT COUNT(*) FROM assistant_notes WHERE user_id = ${row.userId}) < ${limit}
    `);
    return result.rowsAffected > 0;
  }

  async count(userId: string): Promise<number> {
    const [row] = await this.db.select({ total: count() }).from(assistantNotes).where(eq(assistantNotes.userId, userId));
    return row?.total ?? 0;
  }

  list(userId: string): Promise<NoteRow[]> {
    return this.db.select().from(assistantNotes).where(eq(assistantNotes.userId, userId)).orderBy(desc(assistantNotes.createdAt));
  }

  async find(userId: string, id: string): Promise<NoteRow | null> {
    const [row] = await this.db
      .select()
      .from(assistantNotes)
      .where(and(eq(assistantNotes.id, id), eq(assistantNotes.userId, userId)));
    return row ?? null;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(assistantNotes)
      .where(and(eq(assistantNotes.id, id), eq(assistantNotes.userId, userId)))
      .returning({ id: assistantNotes.id });
    return rows.length > 0;
  }
}
