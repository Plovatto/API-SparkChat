import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_BYTES = 32;
const MAX_TOKEN_LENGTH = 512;

export interface CallDeclineTokenOptions {
  key?: Buffer;
  now?: () => number;
}

export class CallDeclineTokens {
  private readonly key: Buffer;
  private readonly now: () => number;

  constructor(options: CallDeclineTokenOptions = {}) {
    this.key = options.key ?? randomBytes(KEY_BYTES);
    this.now = options.now ?? Date.now;
  }

  issue(userId: string, callId: string, expiresAtMs: number): string {
    const expiry = String(Math.floor(expiresAtMs));
    return `${Buffer.from(userId, 'utf8').toString('base64url')}.${expiry}.${this.sign(userId, callId, expiry)}`;
  }

  verify(token: string, callId: string): { userId: string } | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      return null;
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    const [encodedUser, expiry, mac] = parts as [string, string, string];
    if (!/^\d{1,16}$/.test(expiry) || Number(expiry) < this.now()) {
      return null;
    }
    const userId = Buffer.from(encodedUser, 'base64url').toString('utf8');
    if (userId.length === 0 || Buffer.from(userId, 'utf8').toString('base64url') !== encodedUser) {
      return null;
    }
    const expected = Buffer.from(this.sign(userId, callId, expiry), 'utf8');
    const given = Buffer.from(mac, 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return null;
    }
    return { userId };
  }

  private sign(userId: string, callId: string, expiry: string): string {
    return createHmac('sha256', this.key).update(`call-decline\n${userId}\n${callId}\n${expiry}`).digest('base64url');
  }
}
