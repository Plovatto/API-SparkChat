import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('SPRK', 'ascii');
const VERSION = 1;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ALGORITHM = 'aes-256-gcm';

export interface RecoveryFilePayload {
  userId: string;
  recoveryToken: string;
}

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function encodeRecoveryFile(payload: RecoveryFilePayload, secret: string): Buffer {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, authTag, ciphertext]);
}

export function decodeRecoveryFile(file: Buffer, secret: string): RecoveryFilePayload {
  const headerLength = MAGIC.length + 1 + IV_LENGTH + AUTH_TAG_LENGTH;
  if (file.length <= headerLength) {
    throw new Error('Arquivo de recuperação inválido.');
  }

  const magic = file.subarray(0, MAGIC.length);
  if (!magic.equals(MAGIC)) {
    throw new Error('Arquivo de recuperação inválido.');
  }

  const version = file.readUInt8(MAGIC.length);
  if (version !== VERSION) {
    throw new Error('Arquivo de recuperação inválido.');
  }

  let offset = MAGIC.length + 1;
  const iv = file.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const authTag = file.subarray(offset, offset + AUTH_TAG_LENGTH);
  offset += AUTH_TAG_LENGTH;
  const ciphertext = file.subarray(offset);

  const key = deriveKey(secret);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Arquivo de recuperação inválido ou corrompido.');
  }

  const parsed = JSON.parse(plaintext.toString('utf8')) as Partial<RecoveryFilePayload>;
  if (typeof parsed.userId !== 'string' || typeof parsed.recoveryToken !== 'string') {
    throw new Error('Arquivo de recuperação inválido.');
  }

  return { userId: parsed.userId, recoveryToken: parsed.recoveryToken };
}
