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

describe('private room creation limits', () => {
  it('caps new private rooms per user per day and frees the budget afterwards', () => {
    let now = 1_000_000;
    const limiter = new RoomActionRateLimiter(() => now);

    for (let index = 0; index < 30; index += 1) {
      expect(limiter.tryCreatePrivateRoom('a')).toBe(true);
    }
    expect(limiter.tryCreatePrivateRoom('a')).toBe(false);
    expect(limiter.tryCreatePrivateRoom('b')).toBe(true);

    now += 24 * 60 * 60 * 1000 + 1;
    expect(limiter.tryCreatePrivateRoom('a')).toBe(true);
  });

  it('caps unknown nickname lookups per user', () => {
    const limiter = new RoomActionRateLimiter();

    for (let index = 0; index < 10; index += 1) {
      expect(limiter.tryPrivateLookupMiss('a')).toBe(true);
    }
    expect(limiter.tryPrivateLookupMiss('a')).toBe(false);
  });
});
