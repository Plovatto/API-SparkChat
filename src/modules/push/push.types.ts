export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high';

export type PushCallEndReason = 'completed' | 'missed' | 'declined' | 'cancelled' | 'busy' | 'failed' | 'connection-lost' | 'answered';

export type PushPayload =
  | { t: 'call'; callId: string; roomId: string; kind: 'voice' | 'video' }
  | { t: 'call-end'; callId: string; reason: PushCallEndReason }
  | { t: 'msg'; roomId: string; m?: PushMessagePreview };

export type PushPreviewKind = 'text' | 'image' | 'audio' | 'file';

export interface PushMessagePreview {
  id: string;
  s: string;
  k: PushPreviewKind;
  c?: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  sessionId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
}

export interface PushSessionTimes {
  createdAt: string;
  lastUsedAt: string;
}

export interface ActivePushSubscription extends PushSubscriptionRecord {
  session: PushSessionTimes;
}

export interface PushSendOptions {
  TTL: number;
  urgency: PushUrgency;
  topic: string;
}

export type PushSender = (subscription: PushSubscriptionInput, payload: string, options: PushSendOptions) => Promise<void>;

export class PushDeliveryError extends Error {
  constructor(readonly statusCode: number | null) {
    super(`Push delivery failed${statusCode === null ? '' : ` with status ${statusCode}`}`);
    this.name = 'PushDeliveryError';
  }
}

export interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
}

export const MAX_SUBSCRIPTIONS_PER_USER = 10;
export const MAX_ENDPOINT_LENGTH = 1024;
export const MAX_USER_AGENT_LENGTH = 200;
export const MAX_CONCURRENT_SENDS = 32;
export const MAX_PUSH_PAYLOAD_BYTES = 3000;
export const ENCRYPTED_FIELD_PREFIX = 'e2e:v2:';
export const MAX_QUEUED_SENDS = 2000;
export const PUSH_ALLOWED_HOSTS = ['fcm.googleapis.com', 'web.push.apple.com'] as const;
export const PUSH_ALLOWED_HOST_SUFFIXES = ['.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com'] as const;
