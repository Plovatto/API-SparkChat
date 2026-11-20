import { logger } from '../../config/logger.js';
import type { InclusionResult, KeySnapshot, TransparencyLog } from './transparency.log.js';
import type { SignedTreeHead } from './transparency.signer.js';

export const MAX_PROOF_ITEMS = 50;
export const MAX_AUDIT_ENTRIES = 50;
export const MAX_GOSSIP_ENVELOPE_LENGTH = 2048;

export interface KeyDirectory {
  findKeys(userId: string): Promise<{ publicKey: string; signingPublicKey: string | null } | null>;
  listKeyedUsers(afterId: string, limit: number): Promise<{ id: string; publicKey: string; signingPublicKey: string | null }[]>;
}

export interface TransparencyConfig {
  enabled: true;
  logPublicKey: string;
}

export interface ProofRequestItem {
  userId: string;
  publicKey: string;
  signingPublicKey?: string | undefined;
}

export type ProofResult =
  | ({ userId: string; found: true } & InclusionResult)
  | { userId: string; found: false };

const BACKFILL_PAGE = 500;

export class TransparencyService {
  constructor(
    private readonly log: TransparencyLog,
    private readonly directory: KeyDirectory,
  ) {}

  getConfig(): TransparencyConfig {
    return { enabled: true, logPublicKey: this.log.publicKey };
  }

  async recordUser(userId: string): Promise<void> {
    try {
      const keys = await this.directory.findKeys(userId);
      if (keys) {
        await this.log.record({ userId, ...keys });
      }
    } catch (error) {
      logger.error({ err: error }, 'Key transparency could not record a key change');
    }
  }

  async backfill(): Promise<number> {
    let appended = 0;
    let after = '';
    for (;;) {
      const page = await this.directory.listKeyedUsers(after, BACKFILL_PAGE);
      const last = page[page.length - 1];
      if (!last) {
        return appended;
      }
      appended += await this.log.recordMany(page.map((row) => ({ userId: row.id, publicKey: row.publicKey, signingPublicKey: row.signingPublicKey })));
      after = last.id;
    }
  }

  head(): Promise<SignedTreeHead> {
    return this.log.head();
  }

  private async repairIfCurrent(item: ProofRequestItem): Promise<void> {
    const snapshot: KeySnapshot = { userId: item.userId, publicKey: item.publicKey, signingPublicKey: item.signingPublicKey ?? null };
    if (await this.log.hasLeaf(snapshot)) {
      return;
    }
    const current = await this.directory.findKeys(item.userId);
    if (current && current.publicKey === snapshot.publicKey && current.signingPublicKey === snapshot.signingPublicKey) {
      await this.log.record(snapshot);
    }
  }

  async proofs(items: ProofRequestItem[]): Promise<{ head: SignedTreeHead; proofs: ProofResult[] }> {
    for (const item of items) {
      await this.repairIfCurrent(item).catch((error: unknown) => {
        logger.error({ err: error }, 'Key transparency repair failed');
      });
    }
    const head = await this.log.head();
    const proofs: ProofResult[] = [];
    for (const item of items) {
      const inclusion = await this.log.inclusion({ userId: item.userId, publicKey: item.publicKey, signingPublicKey: item.signingPublicKey ?? null }, head);
      proofs.push(inclusion ? { userId: item.userId, found: true, ...inclusion } : { userId: item.userId, found: false });
    }
    return { head, proofs };
  }

  consistency(first: number, second: number): Promise<string[] | 'beyond' | null> {
    return this.log.consistency(first, second);
  }

  async audit(userId: string, fromVersion: number): Promise<{ head: SignedTreeHead; entries: Awaited<ReturnType<TransparencyLog['audit']>>['entries']; truncated: boolean }> {
    await this.recordUser(userId);
    const head = await this.log.head();
    const { entries, truncated } = await this.log.audit(userId, head, fromVersion, MAX_AUDIT_ENTRIES);
    return { head, entries, truncated };
  }
}
