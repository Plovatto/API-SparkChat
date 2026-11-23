import type { Request, RequestHandler } from 'express';
import type { UserRecord, UserService } from '../modules/users/index.js';
import { errorPayload } from '../lib/app-error.js';
import {
  EMPTY_BODY_SHA256,
  UNSIGNED_PAYLOAD,
  sessionProofSchema,
  signatureFailurePayload,
  type SessionProof,
  type SignedRequest,
} from '../modules/users/user.session-signature.js';
import { asyncHandler } from './async-handler.js';

declare module 'express-serve-static-core' {
  interface Request {
    authenticatedUser?: UserRecord;
    authenticatedSessionId?: string;
    rawBodySha256?: string;
  }
}

export const SIGNATURE_HEADERS = {
  timestamp: 'x-spark-timestamp',
  nonce: 'x-spark-nonce',
  signature: 'x-spark-signature',
} as const;

export interface RequireAuthOptions {
  allowUnsigned?: boolean;
}

export function readSessionProof(req: Request): SessionProof | null {
  const timestamp = req.get(SIGNATURE_HEADERS.timestamp);
  const nonce = req.get(SIGNATURE_HEADERS.nonce);
  const signature = req.get(SIGNATURE_HEADERS.signature);
  if (!timestamp || !nonce || !signature || !/^\d{1,16}$/.test(timestamp)) {
    return null;
  }

  const parsed = sessionProofSchema.safeParse({ timestamp: Number(timestamp), nonce, signature });
  return parsed.success ? parsed.data : null;
}

export function describeSignedRequest(req: Request): SignedRequest {
  const bodyHash = req.is('multipart/form-data') ? UNSIGNED_PAYLOAD : (req.rawBodySha256 ?? EMPTY_BODY_SHA256);
  return { method: req.method, path: req.originalUrl, bodyHash };
}

export function parseBearerToken(header: string | undefined): { userId: string; sessionToken: string } | null {
  if (!header?.startsWith('Bearer ')) {
    return null;
  }

  const value = header.slice('Bearer '.length).trim();
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return null;
  }

  return {
    userId: value.slice(0, separatorIndex),
    sessionToken: value.slice(separatorIndex + 1),
  };
}

export function createRequireAuth(userService: UserService, options: RequireAuthOptions = {}): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    const credentials = parseBearerToken(req.headers.authorization);
    if (!credentials) {
      res.status(401).json(errorPayload('auth.required'));
      return;
    }

    let authenticated;
    try {
      authenticated = options.allowUnsigned
        ? await userService.authenticateSession(credentials.userId, credentials.sessionToken)
        : await userService.authenticateSignedSession(credentials.userId, credentials.sessionToken, readSessionProof(req), describeSignedRequest(req));
    } catch (error) {
      const payload = signatureFailurePayload(error);
      if (!payload) {
        throw error;
      }
      res.status(401).json(payload);
      return;
    }

    if (!authenticated) {
      res.status(401).json(errorPayload('auth.sessionInvalid'));
      return;
    }

    req.authenticatedUser = authenticated.user;
    req.authenticatedSessionId = authenticated.sessionId;
    next();
  });
}
