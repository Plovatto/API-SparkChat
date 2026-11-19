import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  currentPasswordHashParams,
  DEFAULT_PASSWORD_HASH_PARAMS,
  hashPassword,
  passwordHashNeedsRehash,
  verifyPassword,
} from '@/modules/users/user.password.js';

const scryptAsync = promisify(scrypt);

async function legacyHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

function encodedHash(cost: number, blockSize: number, saltHex: string, keyHex: string): string {
  return ['scrypt', cost, blockSize, 1, saltHex, keyHex].join('$');
}

describe('user.password', () => {
  it('verifies the correct password against its hash', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');

    await expect(verifyPassword('correct-horse-battery-staple', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');

    await expect(verifyPassword('wrong-password', hash)).resolves.toBe(false);
  });

  it('produces a different hash for the same password each time', async () => {
    const first = await hashPassword('correct-horse-battery-staple');
    const second = await hashPassword('correct-horse-battery-staple');

    expect(first).not.toBe(second);
  });

  it('rejects a malformed stored hash', async () => {
    await expect(verifyPassword('anything', 'not-a-valid-hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', encodedHash(3, 8, '00', '00'))).resolves.toBe(false);
    await expect(verifyPassword('anything', encodedHash(16384, 8, 'zz', '00'))).resolves.toBe(false);
  });

  it('uses scrypt with N=2^16, r=8 and p=1 by default for new hashes', () => {
    expect(DEFAULT_PASSWORD_HASH_PARAMS).toEqual({ cost: 2 ** 16, blockSize: 8, parallelization: 1 });
  });

  it('stores the scrypt parameters in the hash string', async () => {
    const hash = await hashPassword('correct-horse-battery-staple', { cost: 2 ** 15, blockSize: 8, parallelization: 1 });

    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    await expect(verifyPassword('correct-horse-battery-staple', hash)).resolves.toBe(true);
  });

  it('verifies a hash made with the production parameters', async () => {
    const hash = await hashPassword('correct-horse-battery-staple', DEFAULT_PASSWORD_HASH_PARAMS);

    expect(hash.startsWith(['scrypt', 65536, 8, 1, ''].join('$'))).toBe(true);
    await expect(verifyPassword('correct-horse-battery-staple', hash)).resolves.toBe(true);
  });

  it('still verifies legacy salt:key hashes', async () => {
    const hash = await legacyHash('correct-horse-battery-staple');

    await expect(verifyPassword('correct-horse-battery-staple', hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', hash)).resolves.toBe(false);
  });

  it('asks to rehash legacy hashes and hashes with other parameters only', async () => {
    const legacy = await legacyHash('correct-horse-battery-staple');
    const current = await hashPassword('correct-horse-battery-staple');
    const weaker = await hashPassword('correct-horse-battery-staple', { ...currentPasswordHashParams(), blockSize: 4 });

    expect(passwordHashNeedsRehash(legacy)).toBe(true);
    expect(passwordHashNeedsRehash(weaker)).toBe(true);
    expect(passwordHashNeedsRehash(current)).toBe(false);
  });

  it('refuses parameters that would exceed the memory cap instead of throwing', async () => {
    await expect(verifyPassword('anything', encodedHash(131072, 32, '00'.repeat(16), '00'.repeat(64)))).resolves.toBe(false);
  });
});
