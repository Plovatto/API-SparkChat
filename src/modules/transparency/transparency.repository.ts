import { and, asc, count, desc, eq, gte, or } from 'drizzle-orm';
import type { Database } from '../../database/turso-client.js';
import { transparencyLeaves, transparencyMeta, transparencyNodes } from '../../database/schema.js';

export interface LeafRow {
  position: number;
  leafId: string;
  version: number;
  identityKey: string;
  signingKey: string;
  leafHash: string;
  createdAt: string;
}

export interface NodeRow {
  level: number;
  position: number;
  hash: string;
}

const INSERT_CHUNK = 100;
const NODE_READ_CHUNK = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export class TransparencyRepository {
  constructor(private readonly db: Database) {}

  async size(): Promise<number> {
    const [row] = await this.db.select({ total: count() }).from(transparencyLeaves);
    return row?.total ?? 0;
  }

  async readNodes(keys: { level: number; position: number }[]): Promise<Map<string, Buffer>> {
    const nodes = new Map<string, Buffer>();
    for (const batch of chunk(keys, NODE_READ_CHUNK)) {
      const rows = await this.db
        .select()
        .from(transparencyNodes)
        .where(or(...batch.map((key) => and(eq(transparencyNodes.level, key.level), eq(transparencyNodes.position, key.position)))));
      for (const row of rows) {
        nodes.set(`${row.level}/${row.position}`, Buffer.from(row.hash, 'base64url'));
      }
    }
    return nodes;
  }

  async append(leaves: LeafRow[], nodes: NodeRow[]): Promise<void> {
    const statements = [
      ...chunk(leaves, INSERT_CHUNK).map((rows) => this.db.insert(transparencyLeaves).values(rows)),
      ...chunk(nodes, INSERT_CHUNK).map((rows) => this.db.insert(transparencyNodes).values(rows)),
    ];
    const [first, ...rest] = statements;
    if (!first) {
      return;
    }
    await this.db.batch([first, ...rest]);
  }

  async findLeaf(leafId: string, identityKey: string, signingKey: string): Promise<LeafRow | null> {
    const [row] = await this.db
      .select()
      .from(transparencyLeaves)
      .where(
        and(
          eq(transparencyLeaves.leafId, leafId),
          eq(transparencyLeaves.identityKey, identityKey),
          eq(transparencyLeaves.signingKey, signingKey),
        ),
      )
      .orderBy(desc(transparencyLeaves.version))
      .limit(1);
    return row ?? null;
  }

  async latestLeaf(leafId: string): Promise<LeafRow | null> {
    const [row] = await this.db
      .select()
      .from(transparencyLeaves)
      .where(eq(transparencyLeaves.leafId, leafId))
      .orderBy(desc(transparencyLeaves.version))
      .limit(1);
    return row ?? null;
  }

  listLeaves(leafId: string, fromVersion: number, limit: number): Promise<LeafRow[]> {
    return this.db
      .select()
      .from(transparencyLeaves)
      .where(and(eq(transparencyLeaves.leafId, leafId), gte(transparencyLeaves.version, fromVersion)))
      .orderBy(asc(transparencyLeaves.version))
      .limit(limit);
  }

  async getMeta(key: string): Promise<string | null> {
    const [row] = await this.db.select().from(transparencyMeta).where(eq(transparencyMeta.key, key));
    return row?.value ?? null;
  }

  async setMetaIfAbsent(key: string, value: string): Promise<void> {
    await this.db.insert(transparencyMeta).values({ key, value }).onConflictDoNothing();
  }
}
