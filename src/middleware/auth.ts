import type { NextFunction, Request, Response } from 'express';
import type { UserRecord } from '../modules/users/index.js';
import type { UserService } from '../modules/users/index.js';

declare module 'express-serve-static-core' {
  interface Request {
    authenticatedUser?: UserRecord;
  }
}

function parseBearerToken(header: string | undefined): { userId: string; sessionToken: string } | null {
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

export function createRequireAuth(userService: UserService) {
  return async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const credentials = parseBearerToken(req.headers.authorization);
    if (!credentials) {
      res.status(401).json({ message: 'Autenticação necessária.' });
      return;
    }

    const user = await userService.verifySession(credentials.userId, credentials.sessionToken);
    if (!user) {
      res.status(401).json({ message: 'Sessão inválida ou expirada.' });
      return;
    }

    req.authenticatedUser = user;
    next();
  };
}
