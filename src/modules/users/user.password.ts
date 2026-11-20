import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { env } from '../../config/env.js';

export interface PasswordHashParams {
  cost: number;
  blockSize: number;
  parallelization: number;
}

interface ParsedHash {
  params: PasswordHashParams;
  salt: Buffer;
  key: Buffer;
  legacy: boolean;
}

const HASH_PREFIX = 'scrypt';
const HASH_SEPARATOR = '$';
const SALT_BYTES = 16;
const KEY_LENGTH = 64;
const MAX_MEMORY_BYTES = 256 * 1024 * 1024;
const MAX_COST = 2 ** 17;
const MAX_BLOCK_SIZE = 32;
const MAX_PARALLELIZATION = 16;

const MAX_CONCURRENT_DERIVATIONS = 4;
const MAX_QUEUED_VERIFICATIONS = 8;

export class PasswordCapacityError extends Error {
  constructor() {
    super('Password verification capacity exceeded');
    this.name = 'PasswordCapacityError';
  }
}

export class DerivationGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {}

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiting.length;
  }

  async run<T>(task: () => Promise<T>, options: { shed: boolean }): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (options.shed && this.waiting.length >= this.maxQueued) {
        throw new PasswordCapacityError();
      }
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    } else {
      this.active += 1;
    }

    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.active -= 1;
      }
    }
  }
}

const derivationGate = new DerivationGate(MAX_CONCURRENT_DERIVATIONS, MAX_QUEUED_VERIFICATIONS);

export function passwordDerivationGate(): DerivationGate {
  return derivationGate;
}

const LEGACY_PARAMS: PasswordHashParams = { cost: 16384, blockSize: 8, parallelization: 1 };

export const DEFAULT_PASSWORD_HASH_PARAMS: PasswordHashParams = { cost: 2 ** 16, blockSize: 8, parallelization: 1 };

export function currentPasswordHashParams(): PasswordHashParams {
  return { ...DEFAULT_PASSWORD_HASH_PARAMS, cost: env.PASSWORD_SCRYPT_COST };
}

function deriveKey(password: string, salt: Buffer, params: PasswordHashParams, keyLength: number): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.cost,
    r: params.blockSize,
    p: params.parallelization,
    maxmem: MAX_MEMORY_BYTES,
  };

  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 1 && (value & (value - 1)) === 0;
}

function isSupportedParams(params: PasswordHashParams): boolean {
  return (
    isPowerOfTwo(params.cost) &&
    params.cost <= MAX_COST &&
    Number.isInteger(params.blockSize) &&
    params.blockSize >= 1 &&
    params.blockSize <= MAX_BLOCK_SIZE &&
    Number.isInteger(params.parallelization) &&
    params.parallelization >= 1 &&
    params.parallelization <= MAX_PARALLELIZATION
  );
}

function decodeHex(value: string | undefined): Buffer | null {
  if (!value || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    return null;
  }
  return Buffer.from(value, 'hex');
}

function parseHash(storedHash: string): ParsedHash | null {
  if (storedHash.startsWith(`${HASH_PREFIX}${HASH_SEPARATOR}`)) {
    const [, cost, blockSize, parallelization, saltHex, keyHex, ...rest] = storedHash.split(HASH_SEPARATOR);
    const params: PasswordHashParams = {
      cost: Number(cost),
      blockSize: Number(blockSize),
      parallelization: Number(parallelization),
    };
    const salt = decodeHex(saltHex);
    const key = decodeHex(keyHex);
    if (rest.length > 0 || !salt || !key || !isSupportedParams(params)) {
      return null;
    }
    return { params, salt, key, legacy: false };
  }

  const [saltHex, keyHex, ...rest] = storedHash.split(':');
  const salt = decodeHex(saltHex);
  const key = decodeHex(keyHex);
  if (rest.length > 0 || !salt || !key) {
    return null;
  }
  return { params: LEGACY_PARAMS, salt, key, legacy: true };
}

export async function hashPassword(password: string, params: PasswordHashParams = currentPasswordHashParams()): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derivedKey = await derivationGate.run(() => deriveKey(password, salt, params, KEY_LENGTH), { shed: false });
  return [HASH_PREFIX, params.cost, params.blockSize, params.parallelization, salt.toString('hex'), derivedKey.toString('hex')].join(
    HASH_SEPARATOR,
  );
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parsed = parseHash(storedHash);
  if (!parsed) {
    return false;
  }

  let derivedKey: Buffer;
  try {
    derivedKey = await derivationGate.run(() => deriveKey(password, parsed.salt, parsed.params, parsed.key.length), { shed: true });
  } catch (error) {
    if (error instanceof PasswordCapacityError) {
      throw error;
    }
    return false;
  }

  if (derivedKey.length !== parsed.key.length) {
    return false;
  }

  return timingSafeEqual(derivedKey, parsed.key);
}

export function passwordHashNeedsRehash(storedHash: string, params: PasswordHashParams = currentPasswordHashParams()): boolean {
  const parsed = parseHash(storedHash);
  if (!parsed || parsed.legacy) {
    return true;
  }

  return (
    parsed.params.cost !== params.cost ||
    parsed.params.blockSize !== params.blockSize ||
    parsed.params.parallelization !== params.parallelization ||
    parsed.key.length !== KEY_LENGTH
  );
}
