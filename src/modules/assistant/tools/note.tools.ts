import { z } from 'zod';
import { confirmCard } from '../assistant.confirm.js';
import { defineTool } from '../assistant.toolbox.js';
import { NOTE_MAX_LENGTH, type NotesService } from '../notes.service.js';
import { ASSISTANT_TEXTS, truncate } from '../reminder.texts.js';

const PREVIEW_LENGTH = 80;

export function createSaveNoteTool(notes: NotesService) {
  return defineTool({
    declaration: {
      name: 'save_note',
      description: `Saves a private note for the person right away. Use when they ask you to note or save something. Max ${NOTE_MAX_LENGTH} characters.`,
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'The note text, in the language of the person.' } }, required: ['text'] },
    },
    schema: z.object({ text: z.string() }),
    run: async ({ text }, ctx) => {
      const result = await notes.add(ctx.userId, text);
      return { response: result.ok ? { saved: true, noteId: result.note.id } : { error: result.error } };
    },
  });
}

export function createListNotesTool(notes: NotesService) {
  return defineTool({
    declaration: { name: 'list_notes', description: 'Shows the notes the person saved, newest first, with their ids.' },
    schema: z.object({}),
    run: async (_args, ctx) => {
      const items = (await notes.list(ctx.userId)).map((note) => ({ id: note.id, text: note.text }));
      return {
        response: { notes: items },
        card: { v: 1, kind: 'list', title: ASSISTANT_TEXTS.notesTitle[ctx.locale], items },
      };
    },
  });
}

export function createDeleteNoteTool(notes: NotesService) {
  return defineTool({
    declaration: {
      name: 'delete_note',
      description: 'Asks the person to confirm deleting a note. Use only an id returned by list_notes.',
      parameters: { type: 'object', properties: { noteId: { type: 'string' } }, required: ['noteId'] },
    },
    schema: z.object({ noteId: z.string() }),
    run: async ({ noteId }, ctx) => {
      const note = await notes.find(ctx.userId, noteId);
      if (!note) {
        return { response: { error: 'not_found' } };
      }
      const preview = truncate(note.text, PREVIEW_LENGTH);
      return {
        response: { awaitingConfirmation: true, preview },
        card: confirmCard({ type: 'delete-note', noteId: note.id, preview }, ctx.locale),
      };
    },
  });
}
