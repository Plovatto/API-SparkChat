import type { SignedTreeHead } from './transparency.signer.js';
import type { AuditEntry } from './transparency.log.js';
import type { ProofResult, TransparencyConfig } from './transparency.service.js';

export interface TransparencyClientToServerEvents {
  'kt:get-head': (payload?: { requestId?: string }) => void;
  'kt:get-proofs': (payload: {
    requestId?: string;
    treeSize?: number;
    items: { userId: string; publicKey: string; signingPublicKey?: string }[];
  }) => void;
  'kt:get-consistency': (payload: { requestId?: string; first: number; second: number }) => void;
  'kt:audit': (payload?: { requestId?: string; fromVersion?: number }) => void;
  'kt:gossip': (payload: { to: string; envelope: string }) => void;
}

export interface TransparencyServerToClientEvents {
  'kt:config': (payload: TransparencyConfig) => void;
  'kt:head': (payload: { requestId?: string; head: SignedTreeHead }) => void;
  'kt:proofs': (payload: { requestId?: string; head: SignedTreeHead; proofs: ProofResult[] }) => void;
  'kt:consistency': (payload: { requestId?: string; first: number; second: number; proof: string[] | null }) => void;
  'kt:audit': (payload: { requestId?: string; head: SignedTreeHead; entries: AuditEntry[]; truncated: boolean }) => void;
  'kt:gossip': (payload: { from: string; envelope: string }) => void;
}
