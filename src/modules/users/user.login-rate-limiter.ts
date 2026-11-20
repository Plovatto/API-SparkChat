import { ipKey } from '../../lib/client-network.js';
import { SlidingWindowCounter } from '../../lib/sliding-window-counter.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_REGISTER_ATTEMPTS = 10;
const ACCOUNT_WINDOW_MS = 60 * 60 * 1000;
const ACCOUNT_FREE_ATTEMPTS = 10;
const ACCOUNT_BASE_BACKOFF_MS = 1000;
const ACCOUNT_MAX_BACKOFF_MS = 15 * 60 * 1000;
const REAUTH_MAX_ATTEMPTS = 5;
const RESUME_WINDOW_MS = 60 * 1000;
const MAX_RESUMES_PER_SOCKET = 20;
const MAX_RESUMES_PER_IP = 120;
const AUTH_PARAMS_MAX_PER_IP = 60;
const MAX_IP_FAILURES = 30;

function normalizeNickname(nickname: string): string {
  return nickname.trim().toLowerCase();
}

function buildKey(nickname: string, ip: string): string {
  return `${normalizeNickname(nickname)}:${ipKey(ip)}`;
}

export function networkPrefix(ip: string): string {
  const mapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (mapped.includes('.')) {
    return mapped.split('.').slice(0, 3).join('.');
  }
  return ipKey(mapped);
}

function buildAccountKey(nickname: string, ip: string): string {
  return `account:${normalizeNickname(nickname)}:${networkPrefix(ip)}`;
}

function buildIpFailureKey(ip: string): string {
  return `ip-failures:${ipKey(ip)}`;
}

function buildKeyfileKey(ip: string): string {
  return `keyfile:${ipKey(ip)}`;
}

function buildAuthParamsKey(ip: string): string {
  return `auth-params:${ipKey(ip)}`;
}

function buildRegisterKey(ip: string): string {
  return `register:${ipKey(ip)}`;
}

function buildReauthKey(userId: string): string {
  return `reauth:${userId}`;
}

function buildResumeSocketKey(socketId: string): string {
  return `socket:${socketId}`;
}

function buildResumeIpKey(ip: string): string {
  return `ip:${ipKey(ip)}`;
}

export function accountBackoffMs(attempts: number): number {
  if (attempts < ACCOUNT_FREE_ATTEMPTS) {
    return 0;
  }

  const exponent = attempts - ACCOUNT_FREE_ATTEMPTS;
  return Math.min(ACCOUNT_BASE_BACKOFF_MS * 2 ** exponent, ACCOUNT_MAX_BACKOFF_MS);
}

export class LoginRateLimiter {
  private readonly failures = new SlidingWindowCounter(WINDOW_MS);
  private readonly accountFailures = new SlidingWindowCounter(ACCOUNT_WINDOW_MS);
  private readonly resumes = new SlidingWindowCounter(RESUME_WINDOW_MS);
  private readonly authParamsLookups = new SlidingWindowCounter(WINDOW_MS);

  get trackedKeys(): number {
    return this.failures.size + this.accountFailures.size + this.resumes.size + this.authParamsLookups.size;
  }

  sweep(): void {
    this.failures.sweep();
    this.accountFailures.sweep();
    this.resumes.sweep();
    this.authParamsLookups.sweep();
  }

  isBlocked(nickname: string, ip: string): boolean {
    return (
      this.failures.count(buildKey(nickname, ip)) >= MAX_ATTEMPTS ||
      this.failures.count(buildIpFailureKey(ip)) >= MAX_IP_FAILURES ||
      this.isAccountBackingOff(nickname, ip)
    );
  }

  reserveAttempt(nickname: string, ip: string): boolean {
    if (this.isBlocked(nickname, ip)) {
      return false;
    }

    this.failures.record(buildKey(nickname, ip));
    this.accountFailures.record(buildAccountKey(nickname, ip));
    this.failures.record(buildIpFailureKey(ip));
    return true;
  }

  releaseAttempt(nickname: string, ip: string): void {
    this.failures.release(buildKey(nickname, ip));
    this.accountFailures.release(buildAccountKey(nickname, ip));
    this.failures.release(buildIpFailureKey(ip));
  }

  registerSuccess(nickname: string, ip: string): void {
    this.failures.reset(buildKey(nickname, ip));
    this.accountFailures.release(buildAccountKey(nickname, ip));
    this.failures.release(buildIpFailureKey(ip));
  }

  isBlockedByIp(ip: string): boolean {
    return this.failures.count(buildKeyfileKey(ip)) >= MAX_ATTEMPTS;
  }

  reserveAttemptByIp(ip: string): boolean {
    if (this.isBlockedByIp(ip)) {
      return false;
    }

    this.failures.record(buildKeyfileKey(ip));
    return true;
  }

  releaseAttemptByIp(ip: string): void {
    this.failures.release(buildKeyfileKey(ip));
  }

  registerSuccessByIp(ip: string): void {
    this.failures.reset(buildKeyfileKey(ip));
  }

  reserveAuthParamsLookup(ip: string): boolean {
    const key = buildAuthParamsKey(ip);
    if (this.authParamsLookups.count(key) >= AUTH_PARAMS_MAX_PER_IP) {
      return false;
    }

    this.authParamsLookups.record(key);
    return true;
  }

  isBlockedForRegistration(ip: string): boolean {
    return this.failures.count(buildRegisterKey(ip)) >= MAX_REGISTER_ATTEMPTS;
  }

  registerAttemptForRegistration(ip: string): void {
    this.failures.record(buildRegisterKey(ip));
  }

  reserveReauthAttempt(userId: string): boolean {
    const key = buildReauthKey(userId);
    if (this.failures.count(key) >= REAUTH_MAX_ATTEMPTS) {
      return false;
    }

    this.failures.record(key);
    return true;
  }

  releaseReauthAttempt(userId: string): void {
    this.failures.release(buildReauthKey(userId));
  }

  reserveResume(socketId: string, ip: string): boolean {
    const socketKey = buildResumeSocketKey(socketId);
    const ipKey = buildResumeIpKey(ip);
    if (this.resumes.count(socketKey) >= MAX_RESUMES_PER_SOCKET || this.resumes.count(ipKey) >= MAX_RESUMES_PER_IP) {
      return false;
    }

    this.resumes.record(socketKey);
    this.resumes.record(ipKey);
    return true;
  }

  forgetSocket(socketId: string): void {
    this.resumes.reset(buildResumeSocketKey(socketId));
  }

  private isAccountBackingOff(nickname: string, ip: string): boolean {
    const key = buildAccountKey(nickname, ip);
    const backoffMs = accountBackoffMs(this.accountFailures.count(key));
    if (backoffMs === 0) {
      return false;
    }

    const lastAttempt = this.accountFailures.latest(key) ?? 0;
    return Date.now() - lastAttempt < backoffMs;
  }
}
