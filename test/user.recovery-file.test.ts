import { describe, expect, it } from 'vitest';
import { decodeRecoveryFile, encodeRecoveryFile } from '@/modules/users/user.recovery-file.js';

const SECRET = 'a'.repeat(32);
const PAYLOAD = { userId: 'user-1', recoveryToken: 'recovery-token-value' };

describe('user.recovery-file', () => {
  it('round-trips a payload through encode and decode', () => {
    const file = encodeRecoveryFile(PAYLOAD, SECRET);
    const decoded = decodeRecoveryFile(file, SECRET);

    expect(decoded).toEqual(PAYLOAD);
  });

  it('rejects a file decoded with the wrong secret', () => {
    const file = encodeRecoveryFile(PAYLOAD, SECRET);

    expect(() => decodeRecoveryFile(file, 'b'.repeat(32))).toThrow();
  });

  it('rejects a file with a tampered ciphertext byte', () => {
    const file = encodeRecoveryFile(PAYLOAD, SECRET);
    const lastByte = file.length - 1;
    file[lastByte] = (file[lastByte] ?? 0) ^ 0xff;

    expect(() => decodeRecoveryFile(file, SECRET)).toThrow();
  });

  it('rejects a file with a tampered auth tag', () => {
    const file = encodeRecoveryFile(PAYLOAD, SECRET);
    file[5] = (file[5] ?? 0) ^ 0xff;

    expect(() => decodeRecoveryFile(file, SECRET)).toThrow();
  });

  it('rejects a file with an invalid magic header', () => {
    const file = encodeRecoveryFile(PAYLOAD, SECRET);
    file.write('NOPE', 0, 'ascii');

    expect(() => decodeRecoveryFile(file, SECRET)).toThrow();
  });

  it('rejects a file with an unsupported version byte', () => {
    const file = encodeRecoveryFile(PAYLOAD, SECRET);
    file.writeUInt8(99, 4);

    expect(() => decodeRecoveryFile(file, SECRET)).toThrow();
  });

  it('rejects a truncated file', () => {
    const file = encodeRecoveryFile(PAYLOAD, SECRET).subarray(0, 10);

    expect(() => decodeRecoveryFile(file, SECRET)).toThrow();
  });
});
