import { describe, expect, it } from 'vitest';
import { createTestDb } from './support/create-test-db.js';

interface RawClient {
  execute: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
}

async function columnsOf(client: RawClient, table: string): Promise<unknown[]> {
  return (await client.execute(`PRAGMA table_info(${table})`)).rows.map((row) => row.name);
}

describe('migration 0035_assistant_foundation', () => {
  it('adds the assistant columns and the card resolution table', async () => {
    const db = await createTestDb();
    const client = (db as unknown as { $client: RawClient }).$client;

    expect(await columnsOf(client, 'messages')).toEqual(expect.arrayContaining(['assistant_card', 'quick_reply']));
    expect(await columnsOf(client, 'users')).toEqual(expect.arrayContaining(['time_zone', 'status_text_expires_at', 'status_text_previous']));
    expect(await columnsOf(client, 'assistant_card_resolutions')).toEqual(['card_message_id', 'user_id', 'choice', 'resolved_at']);
  });
});
