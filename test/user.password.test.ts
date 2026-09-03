import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '@/modules/users/user.password.js';

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
  });
});
