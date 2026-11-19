export interface WebPushEnv {
  WEB_PUSH_VAPID_PUBLIC_KEY?: string | undefined;
  WEB_PUSH_VAPID_PRIVATE_KEY?: string | undefined;
  WEB_PUSH_SUBJECT?: string | undefined;
}

export interface WebPushVapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PUBLIC_KEY_BYTES = 65;
const PRIVATE_KEY_BYTES = 32;

function decode(value: string): Buffer | null {
  return BASE64URL.test(value) ? Buffer.from(value, 'base64url') : null;
}

function isValidSubject(subject: string): boolean {
  if (/^mailto:[^\s@]+@[^\s@]+$/.test(subject)) {
    return true;
  }
  try {
    return new URL(subject).protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateWebPushEnv(value: WebPushEnv): { path: keyof WebPushEnv; message: string } | null {
  const present = [value.WEB_PUSH_VAPID_PUBLIC_KEY, value.WEB_PUSH_VAPID_PRIVATE_KEY, value.WEB_PUSH_SUBJECT].filter(Boolean).length;
  if (present === 0) {
    return null;
  }
  if (present !== 3) {
    return { path: 'WEB_PUSH_SUBJECT', message: 'WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY and WEB_PUSH_SUBJECT must be set together' };
  }
  const publicKey = decode(value.WEB_PUSH_VAPID_PUBLIC_KEY ?? '');
  if (publicKey?.length !== PUBLIC_KEY_BYTES || publicKey[0] !== 4) {
    return { path: 'WEB_PUSH_VAPID_PUBLIC_KEY', message: 'WEB_PUSH_VAPID_PUBLIC_KEY must be an uncompressed P-256 public key in base64url' };
  }
  if (decode(value.WEB_PUSH_VAPID_PRIVATE_KEY ?? '')?.length !== PRIVATE_KEY_BYTES) {
    return { path: 'WEB_PUSH_VAPID_PRIVATE_KEY', message: 'WEB_PUSH_VAPID_PRIVATE_KEY must be a 32 byte P-256 private key in base64url' };
  }
  if (!isValidSubject(value.WEB_PUSH_SUBJECT ?? '')) {
    return { path: 'WEB_PUSH_SUBJECT', message: 'WEB_PUSH_SUBJECT must be a mailto: address or an https: URL' };
  }
  return null;
}

export function webPushVapidConfig(value: WebPushEnv): WebPushVapidConfig | null {
  if (!value.WEB_PUSH_VAPID_PUBLIC_KEY || !value.WEB_PUSH_VAPID_PRIVATE_KEY || !value.WEB_PUSH_SUBJECT || validateWebPushEnv(value)) {
    return null;
  }
  return { publicKey: value.WEB_PUSH_VAPID_PUBLIC_KEY, privateKey: value.WEB_PUSH_VAPID_PRIVATE_KEY, subject: value.WEB_PUSH_SUBJECT };
}
