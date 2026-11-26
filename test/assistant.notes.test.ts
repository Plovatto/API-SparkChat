import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { assistantNotes } from '@/database/schema.js';
import { NOTE_MAX_LENGTH, NOTES_MAX_PER_USER } from '@/modules/assistant/notes.service.js';
import { setupTasks } from './support/assistant-tasks-fixture.js';

describe('assistant notes', () => {
  it('save_note stores the note sealed with the room key and list_notes returns it as a list card', async () => {
    const t = await setupTasks();
    const saved = await t.toolbox.run('save_note', { text: 'comprar leite' }, t.toolContext());
    expect(saved.response).toMatchObject({ saved: true });

    const [row] = await t.db.select().from(assistantNotes).where(eq(assistantNotes.userId, t.alice.id));
    expect(row?.contentSealed.startsWith('e2e:v2:')).toBe(true);
    expect(row?.contentSealed).not.toContain('leite');

    const listed = await t.toolbox.run('list_notes', {}, t.toolContext());
    expect(listed.card).toEqual({ v: 1, kind: 'list', title: 'Suas anotações', items: [{ id: row?.id, text: 'comprar leite' }] });
  });

  it('refuses the 201st note and notes over the length limit', async () => {
    const t = await setupTasks();
    const sealed = (await t.host.seal(t.alice.id, 'assistantNote', 'seed', 'x')) as string;
    for (let index = 0; index < NOTES_MAX_PER_USER; index += 1) {
      await t.db.insert(assistantNotes).values({ id: randomUUID(), userId: t.alice.id, contentSealed: sealed, createdAt: index });
    }
    const refused = await t.toolbox.run('save_note', { text: 'mais uma' }, t.toolContext());
    expect(refused.response).toEqual({ error: 'limit' });
    expect(await t.notes.add(t.alice.id, 'y'.repeat(NOTE_MAX_LENGTH + 1))).toEqual({ ok: false, error: 'too_long' });
  });

  it('delete_note asks for confirmation and yes removes it, no keeps it', async () => {
    const t = await setupTasks();
    await t.toolbox.run('save_note', { text: 'apagar isto' }, t.toolContext());
    const [row] = await t.db.select().from(assistantNotes);
    const asked = await t.toolbox.run('delete_note', { noteId: row?.id }, t.toolContext());
    expect(asked.card).toMatchObject({
      kind: 'confirm',
      action: { type: 'delete-note', noteId: row?.id, preview: 'apagar isto' },
      buttons: [
        { choice: 'yes', label: 'Sim' },
        { choice: 'no', label: 'Não' },
      ],
    });

    const card = await t.postCard(asked.card as never);
    await t.tap(card.id, 'no');
    expect((await t.assistantTexts()).at(-1)).toBe('Ok, mantive a anotação.');
    expect(await t.db.select().from(assistantNotes)).toHaveLength(1);

    const second = await t.postCard(asked.card as never);
    await t.tap(second.id, 'yes');
    expect((await t.assistantTexts()).at(-1)).toBe('Anotação apagada.');
    expect(await t.db.select().from(assistantNotes)).toHaveLength(0);
  });

  it('does not delete notes of another user', async () => {
    const t = await setupTasks();
    await t.toolbox.run('save_note', { text: 'minha' }, t.toolContext());
    const [row] = await t.db.select().from(assistantNotes);
    expect(await t.notes.remove('outra-pessoa', row?.id as string)).toBe(false);
    const result = await t.toolbox.run('delete_note', { noteId: 'inexistente' }, t.toolContext());
    expect(result.response).toEqual({ error: 'not_found' });
  });
});
