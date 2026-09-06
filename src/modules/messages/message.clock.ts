const PRUNE_THRESHOLD_ROOMS = 1000;
const STALE_AFTER_MS = 60_000;

const lastTimestampMsByRoom = new Map<string, number>();

function pruneStaleRooms(now: number): void {
  const cutoff = now - STALE_AFTER_MS;
  for (const [roomId, last] of lastTimestampMsByRoom) {
    if (last < cutoff) {
      lastTimestampMsByRoom.delete(roomId);
    }
  }
}

export function nextTimestamp(roomId: string): string {
  const now = Date.now();
  const last = lastTimestampMsByRoom.get(roomId) ?? 0;
  const next = now > last ? now : last + 1;
  lastTimestampMsByRoom.set(roomId, next);
  if (lastTimestampMsByRoom.size > PRUNE_THRESHOLD_ROOMS) {
    pruneStaleRooms(now);
  }
  return new Date(next).toISOString();
}
