import { describe, expect, it } from 'vitest';
import { constantTimeEqual, generateToken, hashToken } from '@/modules/users/user.token.js';

describe('user.token', () => {
  it('generates unique tokens', () => {
    expect(generateToken()).not.toBe(generateToken());
  });

  it('hashes the same token to the same value', () => {
    const token = generateToken();

    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('hashes different tokens to different values', () => {
    expect(hashToken(generateToken())).not.toBe(hashToken(generateToken()));
  });

  it('treats equal hashes as equal in constant time', () => {
    const hash = hashToken(generateToken());

    expect(constantTimeEqual(hash, hash)).toBe(true);
  });

  it('treats different-length values as unequal', () => {
    expect(constantTimeEqual('ab', 'abcd')).toBe(false);
  });
});
