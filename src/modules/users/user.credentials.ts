import { createHmac } from 'node:crypto';
import { z } from 'zod';

const CLIENT_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const AUTH_SALT_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const FAKE_SALT_CONTEXT = 'sparkchat:auth-params:fake-salt:v1';
const AUTH_SALT_BYTES = 16;

export const clientSecretSchema = z.string().regex(CLIENT_SECRET_PATTERN);
export const authSaltSchema = z.string().regex(AUTH_SALT_PATTERN);

export function isClientSecret(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_SECRET_PATTERN.test(value);
}

export function isAuthSalt(value: unknown): value is string {
  return typeof value === 'string' && AUTH_SALT_PATTERN.test(value);
}

export function deriveFakeSaltKey(serverSecret: string): Buffer {
  return createHmac('sha256', serverSecret).update(FAKE_SALT_CONTEXT).digest();
}

export function fakeAuthSalt(fakeSaltKey: Buffer, nicknameNormalized: string): string {
  return createHmac('sha256', fakeSaltKey).update(nicknameNormalized).digest().subarray(0, AUTH_SALT_BYTES).toString('base64url');
}
