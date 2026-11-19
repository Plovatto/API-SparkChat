import { sendNotification, WebPushError } from 'web-push';
import type { WebPushVapidConfig } from '../../config/web-push-env.js';
import { PushDeliveryError, type PushSender } from './push.types.js';

const SEND_TIMEOUT_MS = 10_000;

export function createWebPushSender(vapid: WebPushVapidConfig): PushSender {
  const vapidDetails = { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey };
  return async (subscription, payload, options) => {
    try {
      await sendNotification(subscription, payload, {
        vapidDetails,
        TTL: options.TTL,
        urgency: options.urgency,
        topic: options.topic,
        timeout: SEND_TIMEOUT_MS,
        contentEncoding: 'aes128gcm',
      });
    } catch (error) {
      throw new PushDeliveryError(error instanceof WebPushError ? error.statusCode : null);
    }
  };
}
