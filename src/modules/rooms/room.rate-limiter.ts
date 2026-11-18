import { SlidingWindowCounter } from '../../lib/sliding-window-counter.js';

const MAX_JOIN_FAILURES = 10;
const JOIN_FAILURE_WINDOW_MS = 60 * 60 * 1000;
const KEY_REQUEST_WINDOW_MS = 30 * 1000;

export class RoomActionRateLimiter {
  private readonly joinFailures = new SlidingWindowCounter(JOIN_FAILURE_WINDOW_MS);
  private readonly keyRequests = new SlidingWindowCounter(KEY_REQUEST_WINDOW_MS);

  isJoinBlocked(userId: string): boolean {
    return this.joinFailures.count(userId) >= MAX_JOIN_FAILURES;
  }

  registerJoinFailure(userId: string): void {
    this.joinFailures.record(userId);
  }

  tryKeyRequest(userId: string, roomId: string): boolean {
    const key = `${userId}:${roomId}`;
    if (this.keyRequests.count(key) > 0) {
      return false;
    }
    this.keyRequests.record(key);
    return true;
  }
}
