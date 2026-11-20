import type { RoomRecord } from './room.types.js';

export const ROTATION_STALL_MS = 120_000;

export type RotationAuthority = 'unrestricted' | 'initial' | 'admin' | 'adminless' | 'stalled';

export interface RotationAuthorityResult {
  authority: RotationAuthority | null;
  retryAfterMs: number;
}

export function rotationAuthority(
  room: RoomRecord,
  userId: string,
  epoch: number,
  now: number = Date.now(),
  barred = false,
): RotationAuthorityResult {
  if (room.type !== 'group') {
    return { authority: 'unrestricted', retryAfterMs: 0 };
  }
  if (epoch <= 1) {
    return { authority: 'initial', retryAfterMs: 0 };
  }
  if (!barred && room.admins.includes(userId)) {
    return { authority: 'admin', retryAfterMs: 0 };
  }
  if (!barred && room.admins.length === 0) {
    return { authority: 'adminless', retryAfterMs: 0 };
  }
  const startedAt = room.rotationRequiredAt ? Date.parse(room.rotationRequiredAt) : Number.NaN;
  if (Number.isNaN(startedAt)) {
    return { authority: null, retryAfterMs: ROTATION_STALL_MS };
  }
  const retryAfterMs = Math.max(0, startedAt + ROTATION_STALL_MS - now);
  return retryAfterMs === 0 ? { authority: 'stalled', retryAfterMs: 0 } : { authority: null, retryAfterMs };
}
