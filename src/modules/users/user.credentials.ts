import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/app-error.js';

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

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_DECLARED_PASSWORD_LENGTH = 1024;

export const passwordLengthSchema = z.number().int().min(0).max(MAX_DECLARED_PASSWORD_LENGTH).optional();

export function assertPasswordPolicy(declaredLength: number | undefined, required: boolean = env.PASSWORD_LENGTH_DECLARATION_REQUIRED): void {
  if (declaredLength === undefined) {
    if (required) {
      throw AppError.of('user.passwordLengthRequired');
    }
    return;
  }
  if (!Number.isInteger(declaredLength) || declaredLength < MIN_PASSWORD_LENGTH) {
    throw AppError.of('user.passwordTooShort', { minLength: MIN_PASSWORD_LENGTH });
  }
}
