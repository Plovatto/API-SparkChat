import type { PushConfig } from './push.types.js';

export interface PushSubscriptionPayload {
  endpoint: string;
  expirationTime?: number | null | undefined;
  keys: { p256dh: string; auth: string };
}

export interface PushClientToServerEvents {
  'push:config': (payload?: Record<string, never>) => void;
  'push:subscribe': (payload: { subscription: PushSubscriptionPayload }) => void;
  'push:unsubscribe': (payload: { endpoint: string }) => void;
}

export interface PushServerToClientEvents {
  'push:config': (payload: PushConfig) => void;
  'push:subscribed': (payload: { endpoint: string }) => void;
  'push:unsubscribed': (payload: { endpoint: string }) => void;
}
