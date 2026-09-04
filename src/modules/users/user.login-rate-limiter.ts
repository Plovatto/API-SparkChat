import { SlidingWindowCounter } from '../../lib/sliding-window-counter.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_REGISTER_ATTEMPTS = 10;

function buildKey(nickname: string, ip: string): string {
  return `${nickname.trim().toLowerCase()}:${ip}`;
}

function buildKeyfileKey(ip: string): string {
  return `keyfile:${ip}`;
}

function buildRegisterKey(ip: string): string {
  return `register:${ip}`;
}

export class LoginRateLimiter {
  private readonly failures = new SlidingWindowCounter(WINDOW_MS);

  isBlocked(nickname: string, ip: string): boolean {
    return this.failures.count(buildKey(nickname, ip)) >= MAX_ATTEMPTS;
  }

  registerFailure(nickname: string, ip: string): void {
    this.failures.record(buildKey(nickname, ip));
  }

  registerSuccess(nickname: string, ip: string): void {
    this.failures.reset(buildKey(nickname, ip));
  }

  isBlockedByIp(ip: string): boolean {
    return this.failures.count(buildKeyfileKey(ip)) >= MAX_ATTEMPTS;
  }

  registerFailureByIp(ip: string): void {
    this.failures.record(buildKeyfileKey(ip));
  }

  registerSuccessByIp(ip: string): void {
    this.failures.reset(buildKeyfileKey(ip));
  }

  isBlockedForRegistration(ip: string): boolean {
    return this.failures.count(buildRegisterKey(ip)) >= MAX_REGISTER_ATTEMPTS;
  }

  registerAttemptForRegistration(ip: string): void {
    this.failures.record(buildRegisterKey(ip));
  }
}
