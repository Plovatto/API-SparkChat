import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import '../../docs/zod-extend.js';
import { AppError, type ErrorPayload } from '../../lib/app-error.js';
import type { ErrorCode } from '../../lib/error-catalog.js';

export const SESSION_SIGNATURE_MODES = ['bound', 'required'] as const;
export type SessionSignatureMode = (typeof SESSION_SIGNATURE_MODES)[number];

export const SIGNATURE_VERSION = 'SPARKCHAT-SIG-V1';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
export const SOCKET_JOIN_METHOD = 'SOCKET';
export const SOCKET_JOIN_PATH = 'user:join';
const NONCE_CACHE_MAX_ENTRIES = 200_000;
const DEVICE_PUBLIC_KEY_MAX_LENGTH = 200;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const P256_SIGNATURE_BYTES = 64;

export const EMPTY_BODY_SHA256 = sha256Base64Url('');

export const devicePublicKeySchema = z
  .string()
  .min(1)
  .max(DEVICE_PUBLIC_KEY_MAX_LENGTH)
  .regex(BASE64URL_PATTERN)
  .refine((value) => parseDevicePublicKey(value) !== null, { message: 'Invalid device public key' })
  .openapi({
    description: 'Chave pública ECDSA P-256 do dispositivo (SPKI DER em base64url sem padding). Liga a sessão a este dispositivo',
    example: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...',
  });

export const sessionProofSchema = z
  .object({
    timestamp: z.number().int().nonnegative(),
    nonce: z.string().min(16).max(64).regex(BASE64URL_PATTERN),
    signature: z.string().min(1).max(128).regex(BASE64URL_PATTERN),
  })
  .openapi({ description: 'Prova de posse da chave do dispositivo ligada à sessão' });

export type SessionProof = z.infer<typeof sessionProofSchema>;

export interface SignedRequest {
  method: string;
  path: string;
  bodyHash: string;
}

export type SignatureFailure =
  | { code: 'auth.signatureStale'; params: { serverTime: number } }
  | { code: 'auth.signatureRequired' | 'auth.signatureInvalid' | 'auth.signatureReplayed' | 'auth.deviceKeyRequired' };

export const SIGNATURE_FAILURE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'auth.signatureStale',
  'auth.signatureRequired',
  'auth.signatureInvalid',
  'auth.signatureReplayed',
  'auth.deviceKeyRequired',
]);

export function signatureFailurePayload(error: unknown): ErrorPayload | null {
  return error instanceof AppError && SIGNATURE_FAILURE_CODES.has(error.code) ? error.toPayload() : null;
}

export function toSignatureError(failure: SignatureFailure): AppError {
  return failure.code === 'auth.signatureStale' ? AppError.of(failure.code, failure.params) : AppError.of(failure.code);
}

export function sha256Base64Url(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function parseDevicePublicKey(value: string): KeyObject | null {
  if (!BASE64URL_PATTERN.test(value) || value.length > DEVICE_PUBLIC_KEY_MAX_LENGTH) {
    return null;
  }

  try {
    const key = createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      return null;
    }
    return key;
  } catch {
    return null;
  }
}

export function buildCanonicalRequest(userId: string, request: SignedRequest, proof: Pick<SessionProof, 'timestamp' | 'nonce'>): string {
  return [SIGNATURE_VERSION, userId, request.method.toUpperCase(), request.path, String(proof.timestamp), proof.nonce, request.bodyHash].join('\n');
}

export function verifyDeviceSignature(publicKey: string, canonical: string, signature: string): boolean {
  const key = parseDevicePublicKey(publicKey);
  if (!key) {
    return false;
  }

  const signatureBytes = Buffer.from(signature, 'base64url');
  if (signatureBytes.length !== P256_SIGNATURE_BYTES) {
    return false;
  }

  try {
    return verify('sha256', Buffer.from(canonical), { key, dsaEncoding: 'ieee-p1363' }, signatureBytes);
  } catch {
    return false;
  }
}

export class NonceCache {
  private readonly entries = new Map<string, number>();

  constructor(private readonly maxEntries = NONCE_CACHE_MAX_ENTRIES) {}

  claim(key: string, expiresAt: number, now: number): boolean {
    const existing = this.entries.get(key);
    if (existing !== undefined && existing > now) {
      return false;
    }

    if (this.entries.size >= this.maxEntries) {
      this.sweep(now);
    }
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }

    this.entries.delete(key);
    this.entries.set(key, expiresAt);
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(now: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}

export class SessionSignatureVerifier {
  private readonly nonces: NonceCache;

  constructor(
    readonly mode: SessionSignatureMode = 'bound',
    private readonly now: () => number = Date.now,
    nonceCache?: NonceCache,
  ) {
    this.nonces = nonceCache ?? new NonceCache();
  }

  verify(
    session: { id: string; userId: string; devicePublicKey: string | null },
    proof: SessionProof | null,
    request: SignedRequest,
  ): SignatureFailure | null {
    if (!session.devicePublicKey) {
      return this.mode === 'required' ? { code: 'auth.deviceKeyRequired' } : null;
    }

    return this.verifyWithKey(session.id, session.userId, session.devicePublicKey, proof, request);
  }

  verifyWithKey(
    scope: string,
    userId: string,
    publicKey: string,
    proof: SessionProof | null,
    request: SignedRequest,
  ): SignatureFailure | null {
    if (!proof) {
      return { code: 'auth.signatureRequired' };
    }

    const now = this.now();
    if (Math.abs(now - proof.timestamp) > SIGNATURE_WINDOW_MS) {
      return { code: 'auth.signatureStale', params: { serverTime: now } };
    }

    if (!verifyDeviceSignature(publicKey, buildCanonicalRequest(userId, request, proof), proof.signature)) {
      return { code: 'auth.signatureInvalid' };
    }

    if (!this.nonces.claim(`${scope}:${proof.nonce}`, proof.timestamp + SIGNATURE_WINDOW_MS, now)) {
      return { code: 'auth.signatureReplayed' };
    }

    return null;
  }
}
