import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountBackoffMs, LoginRateLimiter } from '@/modules/users/user.login-rate-limiter.js';

describe('LoginRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows attempts below the limit', () => {
    const limiter = new LoginRateLimiter();

    expect(limiter.isBlocked('alice', '127.0.0.1')).toBe(false);
    expect(limiter.reserveAttempt('alice', '127.0.0.1')).toBe(true);
  });

  it('blocks after five reserved attempts for the same nickname and ip', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 5; i += 1) {
      expect(limiter.reserveAttempt('alice', '127.0.0.1')).toBe(true);
    }

    expect(limiter.reserveAttempt('alice', '127.0.0.1')).toBe(false);
    expect(limiter.isBlocked('alice', '127.0.0.1')).toBe(true);
  });

  it('counts in-flight attempts so parallel requests cannot all pass the check', () => {
    const limiter = new LoginRateLimiter();

    const results = Array.from({ length: 50 }, () => limiter.reserveAttempt('alice', '127.0.0.1'));

    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it('does not block a different ip for the same nickname below the account limit', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 5; i += 1) {
      limiter.reserveAttempt('alice', '127.0.0.1');
    }

    expect(limiter.isBlocked('alice', '10.0.0.1')).toBe(false);
  });

  it('resets the per-ip counter after a successful login', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 4; i += 1) {
      limiter.reserveAttempt('alice', '127.0.0.1');
    }
    limiter.reserveAttempt('alice', '127.0.0.1');
    limiter.registerSuccess('alice', '127.0.0.1');

    expect(limiter.isBlocked('alice', '127.0.0.1')).toBe(false);
  });

  it('releases a reserved attempt that did not reach a verdict', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 5; i += 1) {
      limiter.reserveAttempt('alice', '127.0.0.1');
    }
    limiter.releaseAttempt('alice', '127.0.0.1');

    expect(limiter.reserveAttempt('alice', '127.0.0.1')).toBe(true);
  });

  it('treats nicknames case-insensitively', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 5; i += 1) {
      limiter.reserveAttempt('Alice', '127.0.0.1');
    }

    expect(limiter.isBlocked('ALICE', '127.0.0.1')).toBe(true);
  });

  it('backs off a nickname attacked from many ips', () => {
    vi.useFakeTimers();
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 10; i += 1) {
      expect(limiter.reserveAttempt('alice', `10.0.0.${i}`)).toBe(true);
    }

    expect(limiter.reserveAttempt('alice', '10.0.1.1')).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(limiter.reserveAttempt('alice', '10.0.1.1')).toBe(true);
    expect(limiter.reserveAttempt('alice', '10.0.1.2')).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(limiter.reserveAttempt('alice', '10.0.1.2')).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(limiter.reserveAttempt('alice', '10.0.1.2')).toBe(true);
  });

  it('grows the account backoff exponentially up to fifteen minutes', () => {
    expect(accountBackoffMs(9)).toBe(0);
    expect(accountBackoffMs(10)).toBe(1000);
    expect(accountBackoffMs(11)).toBe(2000);
    expect(accountBackoffMs(14)).toBe(16000);
    expect(accountBackoffMs(40)).toBe(15 * 60 * 1000);
  });

  it('blocks keyfile logins by ip after five reserved attempts', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 5; i += 1) {
      expect(limiter.reserveAttemptByIp('127.0.0.1')).toBe(true);
    }

    expect(limiter.reserveAttemptByIp('127.0.0.1')).toBe(false);
    expect(limiter.isBlockedByIp('127.0.0.1')).toBe(true);
  });

  it('resets the keyfile ip counter after a successful keyfile login', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 5; i += 1) {
      limiter.reserveAttemptByIp('127.0.0.1');
    }
    limiter.registerSuccessByIp('127.0.0.1');

    expect(limiter.isBlockedByIp('127.0.0.1')).toBe(false);
  });

  it('does not confuse nickname-based and keyfile ip-based limits for the same ip', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 5; i += 1) {
      limiter.reserveAttempt('alice', '127.0.0.1');
    }

    expect(limiter.isBlockedByIp('127.0.0.1')).toBe(false);
  });

  it('limits password re-authentication attempts per user', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 5; i += 1) {
      expect(limiter.reserveReauthAttempt('user-1')).toBe(true);
    }

    expect(limiter.reserveReauthAttempt('user-1')).toBe(false);
    expect(limiter.reserveReauthAttempt('user-2')).toBe(true);
    limiter.releaseReauthAttempt('user-1');
    expect(limiter.reserveReauthAttempt('user-1')).toBe(true);
  });

  it('limits session resume attempts per socket and per ip', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 20; i += 1) {
      expect(limiter.reserveResume('socket-a', '127.0.0.1')).toBe(true);
    }
    expect(limiter.reserveResume('socket-a', '127.0.0.1')).toBe(false);

    for (let i = 0; i < 100; i += 1) {
      expect(limiter.reserveResume(`socket-${i}`, '127.0.0.1')).toBe(true);
    }
    expect(limiter.reserveResume('socket-new', '127.0.0.1')).toBe(false);
    expect(limiter.reserveResume('socket-new', '10.0.0.1')).toBe(true);
  });

  it('forgets the resume counter of a closed socket', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 20; i += 1) {
      limiter.reserveResume('socket-a', `10.0.0.${i}`);
    }
    limiter.forgetSocket('socket-a');

    expect(limiter.reserveResume('socket-a', '10.0.1.1')).toBe(true);
  });
});
