import { logger } from '../../config/logger.js';
import { leafHashOf, leafIdOf } from './transparency.leaf.js';
import {
  appendLeaves,
  consistencyProof,
  inclusionProof,
  MapNodeSource,
  NodeCollector,
  peakPositions,
  rootHash,
  type NodeSource,
  type PeakEntry,
} from './transparency.merkle.js';
import type { LeafRow, NodeRow, TransparencyRepository } from './transparency.repository.js';
import type { SignedTreeHead, TreeHeadSigner } from './transparency.signer.js';

export interface KeySnapshot {
  userId: string;
  publicKey: string;
  signingPublicKey: string | null;
}

export interface InclusionResult {
  position: number;
  version: number;
  proof: string[];
}

export interface AuditEntry extends InclusionResult {
  publicKey: string;
  signingPublicKey: string | null;
}

const MAX_APPEND_ATTEMPTS = 4;
const MAX_NODE_PLAN = 4096;
const MAX_KEY_BYTES = 255;

function toBase64Url(hashes: Buffer[]): string[] {
  return hashes.map((hash) => hash.toString('base64url'));
}

function isUniqueConflict(error: unknown): boolean {
  const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : '';
  const message = error instanceof Error ? error.message : '';
  return /unique|primary key|constraint/i.test(`${code} ${message}`);
}

function isValidSnapshot(snapshot: KeySnapshot): boolean {
  const identity = Buffer.byteLength(snapshot.publicKey, 'utf8');
  const signing = Buffer.byteLength(snapshot.signingPublicKey ?? '', 'utf8');
  return identity > 0 && identity <= MAX_KEY_BYTES && signing <= MAX_KEY_BYTES;
}

export class TransparencyLog {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly repository: TransparencyRepository,
    private readonly signer: TreeHeadSigner,
    private readonly now: () => number = Date.now,
  ) {}

  get publicKey(): string {
    return this.signer.publicKey;
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async compute<T>(run: (source: NodeSource) => T): Promise<T> {
    const collector = new NodeCollector();
    run(collector);
    if (collector.requested.size > MAX_NODE_PLAN) {
      throw new RangeError('too many nodes requested');
    }
    const nodes = await this.repository.readNodes(
      Array.from(collector.requested.values()).map(({ level, index }) => ({ level, position: index })),
    );
    return run(new MapNodeSource(nodes));
  }

  size(): Promise<number> {
    return this.repository.size();
  }

  async head(): Promise<SignedTreeHead> {
    const size = await this.repository.size();
    const root = await this.rootAt(size);
    return this.signer.sign(size, root, this.now());
  }

  rootAt(size: number): Promise<Buffer> {
    return this.compute((source) => rootHash(source, size));
  }

  async record(snapshot: KeySnapshot): Promise<boolean> {
    return (await this.recordMany([snapshot])) > 0;
  }

  recordMany(snapshots: KeySnapshot[]): Promise<number> {
    if (snapshots.length === 0) {
      return Promise.resolve(0);
    }
    return this.serialized(async () => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await this.appendOnce(snapshots);
        } catch (error) {
          if (!isUniqueConflict(error) || attempt >= MAX_APPEND_ATTEMPTS) {
            throw error;
          }
          logger.warn({ attempt }, 'Key transparency append collided, retrying');
        }
      }
    });
  }

  private async appendOnce(snapshots: KeySnapshot[]): Promise<number> {
    const size = await this.repository.size();
    const peakNodes = await this.repository.readNodes(peakPositions(size).map(({ level, index }) => ({ level, position: index })));
    const peaks: PeakEntry[] = peakPositions(size).map(({ level, index }) => {
      const hash = peakNodes.get(`${level}/${index}`);
      if (!hash) {
        throw new Error('Key transparency log is missing a peak node');
      }
      return { level, hash };
    });

    const latestVersions = new Map<string, { version: number; identityKey: string; signingKey: string }>();
    const leaves: { row: Omit<LeafRow, 'position'>; hash: Buffer }[] = [];
    const createdAt = new Date(this.now()).toISOString();

    for (const snapshot of snapshots) {
      const leafId = leafIdOf(snapshot.userId);
      const leafKey = leafId.toString('base64url');
      const signingKey = snapshot.signingPublicKey ?? '';
      if (!isValidSnapshot(snapshot)) {
        logger.warn({ leafId: leafKey }, 'Key transparency skipped an invalid key snapshot');
        continue;
      }
      let latest = latestVersions.get(leafKey);
      if (!latest) {
        const stored = await this.repository.latestLeaf(leafKey);
        latest = stored ? { version: stored.version, identityKey: stored.identityKey, signingKey: stored.signingKey } : undefined;
      }
      if (latest && latest.identityKey === snapshot.publicKey && latest.signingKey === signingKey) {
        continue;
      }
      const version = (latest?.version ?? 0) + 1;
      const hash = leafHashOf({ leafId, version, identityKey: snapshot.publicKey, signingKey });
      latestVersions.set(leafKey, { version, identityKey: snapshot.publicKey, signingKey });
      leaves.push({
        row: { leafId: leafKey, version, identityKey: snapshot.publicKey, signingKey, leafHash: hash.toString('base64url'), createdAt },
        hash,
      });
    }

    if (leaves.length === 0) {
      return 0;
    }

    const result = appendLeaves(
      size,
      peaks,
      leaves.map((leaf) => leaf.hash),
    );
    const leafRows: LeafRow[] = leaves.map((leaf, offset) => ({ ...leaf.row, position: size + offset }));
    const nodeRows: NodeRow[] = result.nodes.map((node) => ({ level: node.level, position: node.index, hash: node.hash.toString('base64url') }));
    await this.repository.append(leafRows, nodeRows);
    return leaves.length;
  }

  async inclusion(snapshot: KeySnapshot, head: SignedTreeHead): Promise<InclusionResult | null> {
    const row = await this.repository.findLeaf(leafIdOf(snapshot.userId).toString('base64url'), snapshot.publicKey, snapshot.signingPublicKey ?? '');
    if (!row || row.position >= head.size) {
      return null;
    }
    const proof = await this.compute((source) => inclusionProof(source, row.position, head.size));
    return { position: row.position, version: row.version, proof: toBase64Url(proof) };
  }

  async consistency(first: number, second: number): Promise<string[] | 'beyond' | null> {
    if (first < 1 || first > second) {
      return null;
    }
    const size = await this.repository.size();
    if (second > size) {
      return 'beyond';
    }
    return toBase64Url(await this.compute((source) => consistencyProof(source, first, second)));
  }

  async audit(userId: string, head: SignedTreeHead, fromVersion: number, limit: number): Promise<{ entries: AuditEntry[]; truncated: boolean }> {
    const rows = await this.repository.listLeaves(leafIdOf(userId).toString('base64url'), fromVersion, limit + 1);
    const visible = rows.filter((row) => row.position < head.size);
    const page = visible.slice(0, limit);
    const entries: AuditEntry[] = [];
    for (const row of page) {
      const proof = await this.compute((source) => inclusionProof(source, row.position, head.size));
      entries.push({
        position: row.position,
        version: row.version,
        publicKey: row.identityKey,
        signingPublicKey: row.signingKey === '' ? null : row.signingKey,
        proof: toBase64Url(proof),
      });
    }
    return { entries, truncated: visible.length > limit };
  }

  hasLeaf(snapshot: KeySnapshot): Promise<boolean> {
    return this.repository.findLeaf(leafIdOf(snapshot.userId).toString('base64url'), snapshot.publicKey, snapshot.signingPublicKey ?? '').then((row) => row !== null);
  }
}
