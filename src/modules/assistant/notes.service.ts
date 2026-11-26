import { randomUUID } from 'node:crypto';
import type { AssistantHost } from './assistant.host.js';
import type { NotesRepository } from './notes.repository.js';

export const NOTE_MAX_LENGTH = 1000;
export const NOTES_MAX_PER_USER = 200;

export interface Note {
  id: string;
  text: string;
  createdAt: number;
}

export type AddNoteResult = { ok: true; note: Note } | { ok: false; error: 'empty' | 'too_long' | 'limit' | 'unavailable' };

export class NotesService {
  constructor(
    private readonly repository: NotesRepository,
    private readonly host: AssistantHost,
    private readonly now: () => number = Date.now,
  ) {}

  async add(userId: string, rawText: string): Promise<AddNoteResult> {
    const text = rawText.trim();
    if (text.length === 0) {
      return { ok: false, error: 'empty' };
    }
    if (text.length > NOTE_MAX_LENGTH) {
      return { ok: false, error: 'too_long' };
    }
    const id = randomUUID();
    const sealed = await this.host.seal(userId, 'assistantNote', id, text);
    if (!sealed) {
      return { ok: false, error: 'unavailable' };
    }
    const createdAt = this.now();
    const stored = await this.repository.insertIfBelow({ id, userId, contentSealed: sealed, createdAt }, NOTES_MAX_PER_USER);
    return stored ? { ok: true, note: { id, text, createdAt } } : { ok: false, error: 'limit' };
  }

  async list(userId: string): Promise<Note[]> {
    const rows = await this.repository.list(userId);
    const opened = await Promise.all(
      rows.map(async (row) => {
        const text = await this.host.open(userId, 'assistantNote', row.id, row.contentSealed);
        return text === null ? null : { id: row.id, text, createdAt: row.createdAt };
      }),
    );
    return opened.filter((note): note is Note => note !== null);
  }

  async find(userId: string, id: string): Promise<Note | null> {
    const row = await this.repository.find(userId, id);
    if (!row) {
      return null;
    }
    const text = await this.host.open(userId, 'assistantNote', row.id, row.contentSealed);
    return text === null ? null : { id: row.id, text, createdAt: row.createdAt };
  }

  remove(userId: string, id: string): Promise<boolean> {
    return this.repository.remove(userId, id);
  }
}
