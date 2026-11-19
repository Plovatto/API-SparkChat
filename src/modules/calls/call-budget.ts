import type { CallRepository } from './call.repository.js';
import type { CallDegrade } from './call.types.js';

export const FREE_TIER_BYTES = 1_000_000_000_000;
export const BITRATE_CEILING_BYTES_PER_SECOND = 1_500_000 / 8;
const VIDEO_DEGRADE_RATIO = 0.6;
const AUDIO_ONLY_RATIO = 0.8;
const STOP_RELAY_RATIO = 0.95;
const SNAPSHOT_TTL_MS = 30_000;

export interface BudgetSnapshot {
  degrade: CallDegrade;
  relayAvailable: boolean;
  usedBytes: number;
}

export function estimateRelayBytes(durationMs: number, credentialsIssued: number): number {
  if (durationMs <= 0 || credentialsIssued <= 0) {
    return 0;
  }
  return Math.ceil((durationMs / 1000) * BITRATE_CEILING_BYTES_PER_SECOND * credentialsIssued);
}

export function budgetStep(usedBytes: number, tierBytes: number = FREE_TIER_BYTES): Pick<BudgetSnapshot, 'degrade' | 'relayAvailable'> {
  const ratio = usedBytes / tierBytes;
  if (ratio >= STOP_RELAY_RATIO) {
    return { degrade: 'audio-only-relay', relayAvailable: false };
  }
  if (ratio >= AUDIO_ONLY_RATIO) {
    return { degrade: 'audio-only-relay', relayAvailable: true };
  }
  if (ratio >= VIDEO_DEGRADE_RATIO) {
    return { degrade: 'video-360', relayAvailable: true };
  }
  return { degrade: 'none', relayAvailable: true };
}

export function monthKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

export class CallBudget {
  private cached: { snapshot: BudgetSnapshot; at: number } | null = null;

  constructor(
    private readonly repository: CallRepository,
    private readonly now: () => number = Date.now,
    private readonly tierBytes: number = FREE_TIER_BYTES,
  ) {}

  invalidate(): void {
    this.cached = null;
  }

  async snapshot(): Promise<BudgetSnapshot> {
    const current = this.now();
    if (this.cached && current - this.cached.at < SNAPSHOT_TTL_MS) {
      return this.cached.snapshot;
    }

    const stored = await this.repository.getUsage(monthKey(current));
    const open = await this.repository.findOpen();
    const live = open.reduce((total, call) => {
      if (!call.answeredAt || call.relayUsed <= 0) {
        return total;
      }
      return total + estimateRelayBytes(current - Date.parse(call.answeredAt), call.relayUsed);
    }, 0);

    const usedBytes = stored + live;
    const snapshot = { ...budgetStep(usedBytes, this.tierBytes), usedBytes };
    this.cached = { snapshot, at: current };
    return snapshot;
  }
}
