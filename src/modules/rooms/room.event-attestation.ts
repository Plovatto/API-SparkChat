import { z } from 'zod';
import type { SystemEvent } from '../messages/index.js';

export const MAX_ATTESTATION_LENGTH = 1200;
export const ATTESTATION_PARAM = 'att';

const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

export const attestationSchema = z.string().max(MAX_ATTESTATION_LENGTH).optional();

export type AttestedEventType = 'group.memberJoined' | 'group.memberLeft' | 'group.memberRemoved' | 'group.adminPromoted';

export interface AttestationExpectation {
  roomId: string;
  actorId: string;
  type: AttestedEventType;
  targetId?: string;
}

const attestationBodySchema = z.object({
  v: z.literal(1),
  roomId: z.string(),
  epoch: z.number().int().min(0),
  type: z.string(),
  actorId: z.string(),
  targetId: z.string().nullable(),
  counter: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sig: z.string().regex(SIGNATURE_PATTERN),
});

export function acceptableAttestation(raw: string | undefined, expected: AttestationExpectation): string | null {
  if (raw === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const body = attestationBodySchema.safeParse(parsed);
  if (!body.success) {
    return null;
  }
  const { roomId, type, actorId, targetId } = body.data;
  if (roomId !== expected.roomId || type !== expected.type || actorId !== expected.actorId || targetId !== (expected.targetId ?? null)) {
    return null;
  }
  return raw;
}

export function withAttestation(event: SystemEvent, attestation: string | null): SystemEvent {
  return attestation === null ? event : { ...event, params: { ...event.params, [ATTESTATION_PARAM]: attestation } };
}
