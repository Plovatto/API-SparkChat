import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { Database } from './turso-client.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(currentDir, '../../drizzle');

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder });
}
