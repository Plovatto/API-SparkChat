import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { runMigrations } from '@/database/migrate.js';
import * as schema from '@/database/schema.js';

export async function createTestDb(url = ':memory:') {
  const client = createClient({ url });
  const db = drizzle(client, { schema });
  await runMigrations(db);
  return db;
}
