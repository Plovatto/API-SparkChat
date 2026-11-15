import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '@/database/migrate.js';
import * as schema from '@/database/schema.js';
import {
  renderSystemEvent,
  SYSTEM_EVENT_CATALOG,
  SYSTEM_EVENT_TYPES,
  systemEvent,
  type SystemEventType,
} from '@/modules/messages/message.system-events.js';

const SAMPLE_PARAMS: Partial<Record<SystemEventType, Record<string, string | null>>> = {
  'group.created': { actor: 'Alice' },
  'group.memberJoined': { actor: 'Alice' },
  'group.memberLeft': { actor: 'Alice' },
  'group.memberRemoved': { target: 'Bob', actor: 'Alice' },
  'group.adminPromoted': { target: 'Bob', actor: 'Alice' },
};

describe('system event catalog', () => {
  it.each(SYSTEM_EVENT_TYPES)('names %s by domain', (type) => {
    expect(type).toMatch(/^(group|ai)\.[a-z][A-Za-z]+$/);
  });

  it.each(SYSTEM_EVENT_TYPES)('renders a non-empty portuguese sentence for %s', (type) => {
    const render = SYSTEM_EVENT_CATALOG[type] as (params?: object) => string;
    if (render.length > 0) {
      expect(SAMPLE_PARAMS[type]).toBeDefined();
    }

    expect(render(SAMPLE_PARAMS[type]).trim()).not.toBe('');
  });

  it('renders the exact sentences the API stored before system events existed', () => {
    expect(renderSystemEvent(systemEvent('group.created', { actor: 'Alice' }))).toBe('Alice criou o grupo');
    expect(renderSystemEvent(systemEvent('group.memberJoined', { actor: 'Alice' }))).toBe('Alice entrou no grupo');
    expect(renderSystemEvent(systemEvent('group.memberLeft', { actor: 'Alice' }))).toBe('Alice saiu do grupo');
    expect(renderSystemEvent(systemEvent('group.memberRemoved', { target: 'Bob', actor: 'Alice' }))).toBe(
      'Bob foi removido do grupo por Alice',
    );
    expect(renderSystemEvent(systemEvent('group.adminPromoted', { target: 'Bob', actor: 'Alice' }))).toBe(
      'Bob foi promovido a administrador por Alice',
    );
  });
});

const migrationsFolder = path.resolve(import.meta.dirname, '../drizzle');

function readBackfillStatements(): string[] {
  const file = readdirSync(migrationsFolder).find((name) => name.startsWith('0014_') && name.endsWith('.sql'));
  if (!file) {
    throw new Error('system_event migration not found');
  }

  return readFileSync(path.join(migrationsFolder, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.startsWith('UPDATE'));
}

describe('system_event backfill migration', () => {
  it('recognizes the stored sentences and leaves everything else untouched', async () => {
    const client = createClient({ url: ':memory:' });
    await runMigrations(drizzle(client, { schema }));

    const rows: [string, string, string][] = [
      ['m1', 'system', 'Alice criou o grupo'],
      ['m2', 'system', 'Bob entrou no grupo'],
      ['m3', 'system', 'Bob saiu do grupo'],
      ['m4', 'system', 'Bob foi removido do grupo por Alice'],
      ['m5', 'system', 'Bob foi promovido a administrador por Alice'],
      ['m6', 'error', 'Não consegui responder agora. Tente novamente em instantes.'],
      ['m7', 'text', 'Alice criou o grupo'],
      ['m8', 'system', 'Uma frase qualquer'],
    ];
    for (const [id, type, content] of rows) {
      await client.execute({
        sql: "INSERT INTO messages (id, room_id, sender_id, content, type, timestamp, delivered_to, read_by, played_by) VALUES (?, 'room', 'system', ?, ?, '2026-01-01T00:00:00.000Z', '[]', '[]', '[]')",
        args: [id, content, type],
      });
    }

    for (const statement of readBackfillStatements()) {
      await client.execute(statement);
    }

    const result = await client.execute('SELECT id, system_event FROM messages ORDER BY id');
    const events = Object.fromEntries(
      result.rows.map((row) => [row.id as string, row.system_event === null ? null : (JSON.parse(row.system_event as string) as unknown)]),
    );

    expect(events).toEqual({
      m1: { type: 'group.created', params: { actor: 'Alice' } },
      m2: { type: 'group.memberJoined', params: { actor: 'Bob' } },
      m3: { type: 'group.memberLeft', params: { actor: 'Bob' } },
      m4: { type: 'group.memberRemoved', params: { target: 'Bob', actor: 'Alice' } },
      m5: { type: 'group.adminPromoted', params: { target: 'Bob', actor: 'Alice' } },
      m6: { type: 'ai.replyFailed', params: {} },
      m7: null,
      m8: null,
    });
  });
});
