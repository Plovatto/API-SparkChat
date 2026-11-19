import { describe, expect, it } from 'vitest';
import { KEY_REQUEST_INTERVAL_MS, RoomActionRateLimiter } from '@/modules/rooms/room.rate-limiter.js';

describe('RoomActionRateLimiter', () => {
  it('does not count invite code attempts that succeeded', () => {
    const limiter = new RoomActionRateLimiter();

    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect(limiter.tryJoinAttempt('alice')).toBe(true);
      limiter.forgiveJoinAttempt('alice');
    }
    expect(limiter.tryJoinAttempt('alice')).toBe(true);
  });

  it('limits attempts per user, not globally', () => {
    const limiter = new RoomActionRateLimiter();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.tryJoinAttempt('alice');
    }

    expect(limiter.tryJoinAttempt('alice')).toBe(false);
    expect(limiter.tryJoinAttempt('bob')).toBe(true);
  });

  it('allows another key request for the same room after the interval', () => {
    let now = 1_000_000;
    const limiter = new RoomActionRateLimiter(() => now);

    expect(limiter.tryKeyRequest('alice', 'room-1')).toBe(true);
    expect(limiter.tryKeyRequest('alice', 'room-1')).toBe(false);
    expect(limiter.tryKeyRequest('alice', 'room-2')).toBe(true);

    now += KEY_REQUEST_INTERVAL_MS + 1;
    expect(limiter.tryKeyRequest('alice', 'room-1')).toBe(true);
  });
});
