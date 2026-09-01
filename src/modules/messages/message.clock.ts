const lastTimestampMsByRoom = new Map<string, number>();

export function nextTimestamp(roomId: string): string {
  const now = Date.now();
  const last = lastTimestampMsByRoom.get(roomId) ?? 0;
  const next = now > last ? now : last + 1;
  lastTimestampMsByRoom.set(roomId, next);
  return new Date(next).toISOString();
}
