import { describe, expect, it } from 'vitest';
import { LoginRateLimiter } from '@/modules/users/user.login-rate-limiter.js';

describe('LoginRateLimiter', () => {
  it('is not blocked before any failures', () => {
    const limiter = new LoginRateLimiter();

    expect(limiter.isBlocked('alice', '127.0.0.1')).toBe(false);
  });

  it('blocks after reaching the maximum number of failures', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 5; i += 1) {
      limiter.registerFailure('alice', '127.0.0.1');
    }

    expect(limiter.isBlocked('alice', '127.0.0.1')).toBe(true);
  });

  it('does not block a different ip for the same nickname', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 5; i += 1) {
      limiter.registerFailure('alice', '127.0.0.1');
    }

    expect(limiter.isBlocked('alice', '10.0.0.1')).toBe(false);
  });

  it('clears the failure count on a successful login', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 4; i += 1) {
      limiter.registerFailure('alice', '127.0.0.1');
    }
    limiter.registerSuccess('alice', '127.0.0.1');
    limiter.registerFailure('alice', '127.0.0.1');

    expect(limiter.isBlocked('alice', '127.0.0.1')).toBe(false);
  });

  it('is case-insensitive on the nickname', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 5; i += 1) {
      limiter.registerFailure('Alice', '127.0.0.1');
    }

    expect(limiter.isBlocked('ALICE', '127.0.0.1')).toBe(true);
  });

  it('is not blocked by ip before any keyfile failures', () => {
    const limiter = new LoginRateLimiter();

    expect(limiter.isBlockedByIp('127.0.0.1')).toBe(false);
  });

  it('blocks an ip after reaching the maximum number of keyfile failures', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 5; i += 1) {
      limiter.registerFailureByIp('127.0.0.1');
    }

    expect(limiter.isBlockedByIp('127.0.0.1')).toBe(true);
  });

  it('clears the keyfile failure count on a successful login', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 4; i += 1) {
      limiter.registerFailureByIp('127.0.0.1');
    }
    limiter.registerSuccessByIp('127.0.0.1');
    limiter.registerFailureByIp('127.0.0.1');

    expect(limiter.isBlockedByIp('127.0.0.1')).toBe(false);
  });

  it('does not confuse nickname-based and keyfile ip-based limits for the same ip', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 5; i += 1) {
      limiter.registerFailure('alice', '127.0.0.1');
    }

    expect(limiter.isBlockedByIp('127.0.0.1')).toBe(false);
  });
});
