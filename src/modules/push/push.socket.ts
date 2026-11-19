import '../../docs/zod-extend.js';
import { z } from 'zod';
import { registerClientEvents, registerServerEvents } from '../../docs/socket-registry.js';
import type { AppSocket } from '../../sockets/events.js';
import { extractErrorPayload } from '../../sockets/socket-errors.js';
import { runSocketHandler } from '../../sockets/socket-handler.js';
import { requireSocketUserId } from '../../sockets/socket-session.js';
import type { PushService } from './push.service.js';
import { MAX_ENDPOINT_LENGTH } from './push.types.js';

export interface PushSocketDeps {
  pushService: PushService;
}

const endpointSchema = z
  .string()
  .min(1)
  .max(MAX_ENDPOINT_LENGTH)
  .openapi({ description: 'URL https do serviço de push do navegador (FCM, Mozilla, Windows ou Apple)' });
const keySchema = z.string().min(1).max(128);

const configPayloadSchema = z.object({}).optional();
const subscribePayloadSchema = z.object({
  subscription: z.object({
    endpoint: endpointSchema,
    expirationTime: z.number().nullable().optional(),
    keys: z.object({
      p256dh: keySchema.openapi({ description: 'Chave pública P-256 da inscrição em base64url' }),
      auth: keySchema.openapi({ description: 'Segredo de autenticação de 16 bytes em base64url' }),
    }),
  }),
});
const unsubscribePayloadSchema = z.object({ endpoint: endpointSchema });
const endpointResultSchema = z.object({ endpoint: z.string() });

registerClientEvents('push', {
  'push:config': configPayloadSchema,
  'push:subscribe': subscribePayloadSchema,
  'push:unsubscribe': unsubscribePayloadSchema,
});

registerServerEvents('push', ['push:config', 'push:subscribed', 'push:unsubscribed'], {
  'push:config': z.object({ enabled: z.boolean(), publicKey: z.string().nullable() }),
  'push:subscribed': endpointResultSchema,
  'push:unsubscribed': endpointResultSchema,
});

function userAgentOf(socket: AppSocket): string | undefined {
  const value = socket.handshake.headers['user-agent'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function registerPushSocketHandlers(socket: AppSocket, deps: PushSocketDeps): void {
  const { pushService } = deps;

  const handle = (event: string, work: (userId: string) => Promise<void>): void => {
    runSocketHandler(socket, event, async () => {
      const userId = requireSocketUserId(socket);
      if (!userId) {
        return;
      }
      try {
        await work(userId);
      } catch (error) {
        socket.emit('error', { ...extractErrorPayload(error), event });
      }
    });
  };

  socket.on('push:config', (payload) => {
    handle('push:config', () => {
      configPayloadSchema.parse(payload);
      socket.emit('push:config', pushService.getConfig());
      return Promise.resolve();
    });
  });

  socket.on('push:subscribe', (payload) => {
    handle('push:subscribe', async (userId) => {
      const { subscription } = subscribePayloadSchema.parse(payload);
      socket.emit('push:subscribed', await pushService.subscribe(userId, subscription, userAgentOf(socket)));
    });
  });

  socket.on('push:unsubscribe', (payload) => {
    handle('push:unsubscribe', async (userId) => {
      const { endpoint } = unsubscribePayloadSchema.parse(payload);
      socket.emit('push:unsubscribed', await pushService.unsubscribe(userId, endpoint));
    });
  });
}
