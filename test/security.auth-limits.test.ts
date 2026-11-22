import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ipKey } from '@/lib/client-network.js';
import { SlidingWindowCounter } from '@/lib/sliding-window-counter.js';
import { createRateLimiter } from '@/middleware/rate-limit.js';
import { LoginRateLimiter } from '@/modules/users/user.login-rate-limiter.js';
import { DerivationGate, PasswordCapacityError } from '@/modules/users/user.password.js';
import { buildTestApp } from './support/build-test-app.js';

const PASSWORD = 'correct-horse-battery-staple-0123456789abcd';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('nickname availability oracle', () => {
  it('limits availability lookups per network like auth-params', async () => {
    const { app } = await buildTestApp();

    for (let i = 0; i < 60; i += 1) {
      const allowed = await request(app).get('/api/users/nickname-availability').query({ nickname: `probe${i}` });
      expect(allowed.status).toBe(200);
    }

    const limited = await request(app).get('/api/users/nickname-availability').query({ nickname: 'probe61' });
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: 'rateLimit.loginAttempts' });
  });

  it('keeps the availability budget separate from the auth-params budget', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 60; i += 1) {
      expect(limiter.reserveNicknameAvailabilityLookup('203.0.113.7')).toBe(true);
    }

    expect(limiter.reserveNicknameAvailabilityLookup('203.0.113.7')).toBe(false);
    expect(limiter.reserveAuthParamsLookup('203.0.113.7')).toBe(true);
  });
});

describe('oversized auth input', () => {
  it('rejects a 90KB login nickname with 400 and creates no limiter entry', async () => {
    const { app, loginRateLimiter } = await buildTestApp();

    const response = await request(app)
      .post('/api/users/login')
      .send({ nickname: 'n'.repeat(90_000), password: PASSWORD });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'auth.missingCredentials' });
    expect(loginRateLimiter.trackedKeys).toBe(0);
  });

  it('rejects a 1MB login body without creating limiter entries', async () => {
    const { app, loginRateLimiter } = await buildTestApp();

    const response = await request(app)
      .post('/api/users/login')
      .send({ nickname: 'n'.repeat(1_000_000), password: PASSWORD });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(loginRateLimiter.trackedKeys).toBe(0);
  });

  it('rejects an oversized password with 400 and creates no limiter entry', async () => {
    const { app, loginRateLimiter } = await buildTestApp();

    const response = await request(app)
      .post('/api/users/login')
      .send({ nickname: 'Ada', password: 'p'.repeat(5000) });

    expect(response.status).toBe(400);
    expect(loginRateLimiter.trackedKeys).toBe(0);
  });

  it('rejects an oversized nickname for auth params and availability checks', async () => {
    const { app, loginRateLimiter } = await buildTestApp();
    const nickname = 'n'.repeat(5000);

    const params = await request(app).post('/api/users/auth-params').send({ nickname });
    const availability = await request(app).get('/api/users/nickname-availability').query({ nickname });

    expect(params.status).toBe(400);
    expect(availability.status).toBe(400);
    expect(loginRateLimiter.trackedKeys).toBe(0);
  });

  it('still accepts a legitimate login', async () => {
    const { app, userService } = await buildTestApp();
    const { TEST_V2_SIGNUP } = await import('./support/test-constants.js');
    await userService.registerAccount({ nickname: 'Legit', avatar: 0, password: PASSWORD, ...TEST_V2_SIGNUP });

    const response = await request(app).post('/api/users/login').send({ nickname: 'Legit', password: PASSWORD });

    expect(response.status).toBe(200);
  });
});

describe('SlidingWindowCounter memory bounds', () => {
  it('never holds more keys than maxKeys', () => {
    const counter = new SlidingWindowCounter(60_000, 100);

    for (let i = 0; i < 1000; i += 1) {
      counter.record(`key-${i}`);
    }

    expect(counter.size).toBeLessThanOrEqual(100);
    expect(counter.count('key-999')).toBe(1);
    expect(counter.count('key-0')).toBe(0);
  });

  it('sweeps keys whose window expired even if they are never read again', () => {
    vi.useFakeTimers();
    const counter = new SlidingWindowCounter(1000, 1000);
    for (let i = 0; i < 50; i += 1) {
      counter.record(`key-${i}`);
    }

    vi.advanceTimersByTime(1500);
    counter.record('fresh');
    counter.sweep();

    expect(counter.size).toBe(1);
  });

  it('bounds LoginRateLimiter memory under rotating nicknames and sweeps expired entries', () => {
    vi.useFakeTimers();
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 2000; i += 1) {
      limiter.reserveAttempt(`nick-${i}`, `10.0.${Math.floor(i / 250)}.${i % 250}`);
    }
    expect(limiter.trackedKeys).toBeGreaterThan(0);

    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    limiter.sweep();

    expect(limiter.trackedKeys).toBe(0);
  });
});

describe('per-IP login failure budget', () => {
  it('blocks one address that rotates nicknames', () => {
    const limiter = new LoginRateLimiter();
    let accepted = 0;

    for (let i = 0; i < 100; i += 1) {
      if (limiter.reserveAttempt(`rotating-${i}`, '203.0.113.9')) {
        accepted += 1;
      }
    }

    expect(accepted).toBe(30);
    expect(limiter.reserveAttempt('another', '203.0.113.9')).toBe(false);
    expect(limiter.reserveAttempt('another', '203.0.113.10')).toBe(true);
  });

  it('does not count successful logins against the address budget', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 100; i += 1) {
      expect(limiter.reserveAttempt(`user-${i}`, '203.0.113.9')).toBe(true);
      limiter.registerSuccess(`user-${i}`, '203.0.113.9');
    }
  });

  it('answers 429 over HTTP when one address rotates nicknames', async () => {
    const { app } = await buildTestApp();
    let limited: request.Response | null = null;

    for (let i = 0; i < 40 && !limited; i += 1) {
      const response = await request(app).post('/api/users/login').send({ nickname: `ghost-${i}`, password: PASSWORD });
      if (response.status === 429) {
        limited = response;
      }
    }

    expect(limited?.body).toMatchObject({ code: 'rateLimit.loginAttempts' });
  });
});

describe('IPv6 keying', () => {
  it('collapses addresses of the same /64 and keeps IPv4 intact', () => {
    expect(ipKey('2001:db8:1:2:aaaa::1')).toBe(ipKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
    expect(ipKey('2001:db8:1:2::1')).not.toBe(ipKey('2001:db8:1:3::1'));
    expect(ipKey('203.0.113.9')).toBe('203.0.113.9');
    expect(ipKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });

  it('shares login buckets across a /64', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 5; i += 1) {
      expect(limiter.reserveAttempt('victim', `2001:db8:1:2:${i}::1`)).toBe(true);
    }

    expect(limiter.reserveAttempt('victim', '2001:db8:1:2:ffff::1')).toBe(false);
    expect(limiter.reserveAttempt('victim', '2001:db8:1:3::1')).toBe(true);
  });

  it('shares registration, recovery and auth-params budgets across a /64', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < 10; i += 1) {
      limiter.registerAttemptForRegistration(`2001:db8:9:9:${i}::1`);
    }
    expect(limiter.isBlockedForRegistration('2001:db8:9:9:ffff::2')).toBe(true);

    for (let i = 0; i < 5; i += 1) {
      expect(limiter.reserveAttemptByIp(`2001:db8:9:9:${i}::1`)).toBe(true);
    }
    expect(limiter.reserveAttemptByIp('2001:db8:9:9:ffff::3')).toBe(false);

    for (let i = 0; i < 60; i += 1) {
      expect(limiter.reserveAuthParamsLookup(`2001:db8:9:9:${i}::1`)).toBe(true);
    }
    expect(limiter.reserveAuthParamsLookup('2001:db8:9:9:ffff::4')).toBe(false);
  });

  it('keys the HTTP rate limiter by /64', async () => {
    const app = express();
    app.set('trust proxy', true);
    app.use(createRateLimiter({ limit: 2, code: 'rateLimit.api' }));
    app.get('/ping', (_req, res) => {
      res.status(200).end();
    });

    const first = await request(app).get('/ping').set('X-Forwarded-For', '2001:db8:1:2:1::1');
    const second = await request(app).get('/ping').set('X-Forwarded-For', '2001:db8:1:2:2::1');
    const third = await request(app).get('/ping').set('X-Forwarded-For', '2001:db8:1:2:3::1');
    const otherNetwork = await request(app).get('/ping').set('X-Forwarded-For', '2001:db8:1:3::1');

    expect([first.status, second.status, third.status]).toEqual([200, 200, 429]);
    expect(otherNetwork.status).toBe(200);
  });
});

describe('password derivation gate', () => {
  it('runs at most maxConcurrent tasks and sheds beyond the queue limit', async () => {
    const gate = new DerivationGate(2, 3);
    const releases: Array<() => void> = [];
    const started = vi.fn();
    const task = () =>
      new Promise<void>((resolve) => {
        started();
        releases.push(resolve);
      });

    const running = Array.from({ length: 5 }, () => gate.run(task, { shed: true }));

    expect(started).toHaveBeenCalledTimes(2);
    expect(gate.activeCount).toBe(2);
    expect(gate.queuedCount).toBe(3);
    await expect(gate.run(task, { shed: true })).rejects.toBeInstanceOf(PasswordCapacityError);

    while (releases.length > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(running);
    expect(gate.activeCount).toBe(0);
    expect(gate.queuedCount).toBe(0);
  });

  it('never sheds work that opted out of shedding', async () => {
    const gate = new DerivationGate(1, 0);
    const releases: Array<() => void> = [];
    const task = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      });

    const first = gate.run(task, { shed: false });
    const second = gate.run(task, { shed: false });
    expect(gate.queuedCount).toBe(1);

    releases.shift()?.();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    releases.shift()?.();
    await second;
  });

  it('answers 429 with Retry-After when verification capacity is exhausted', async () => {
    const { app, userService } = await buildTestApp();
    vi.spyOn(userService, 'login').mockRejectedValue(new PasswordCapacityError());

    const response = await request(app).post('/api/users/login').send({ nickname: 'Ada', password: PASSWORD });

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('1');
  });
});
