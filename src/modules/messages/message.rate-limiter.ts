import { SlidingWindowCounter } from '../../lib/sliding-window-counter.js';

const MAX_MESSAGES = 20;
const WINDOW_MS = 10 * 1000;

export class MessageRateLimiter {
  private readonly sends = new SlidingWindowCounter(WINDOW_MS);

  isBlocked(userId: string): boolean {
    return this.sends.count(userId) >= MAX_MESSAGES;
  }

  registerSend(userId: string): void {
    this.sends.record(userId);
  }
}
