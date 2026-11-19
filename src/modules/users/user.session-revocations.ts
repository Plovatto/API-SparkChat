import { logger } from '../../config/logger.js';

export interface RevokedSession {
  userId: string;
  sessionId: string;
}

export type SessionRevocationListener = (revoked: RevokedSession) => void;

export class SessionRevocationNotifier {
  private readonly listeners = new Set<SessionRevocationListener>();

  subscribe(listener: SessionRevocationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(revoked: RevokedSession): void {
    for (const listener of this.listeners) {
      try {
        listener(revoked);
      } catch (err) {
        logger.warn({ err, userId: revoked.userId }, 'Failed to notify a session revocation');
      }
    }
  }
}
