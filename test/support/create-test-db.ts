import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { runMigrations } from '@/database/migrate.js';
import * as schema from '@/database/schema.js';

export async function createTestDb() {
  const client = createClient({ url: ':memory:' });
  const db = drizzle(client, { schema });
  await runMigrations(db);
  return db;
}
