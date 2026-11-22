import '../../docs/zod-extend.js';
import { z } from 'zod';
import { registerClientEvents, registerServerEvents } from '../../docs/socket-registry.js';
import { AppError } from '../../lib/app-error.js';
import type { AppSocket } from '../../sockets/events.js';
import { runAuthedSocketHandler } from '../../sockets/socket-handler.js';
import { userRoom } from '../../sockets/user-sockets.js';
import { MAX_GOSSIP_ENVELOPE_LENGTH, MAX_PROOF_ITEMS, type TransparencyService } from './transparency.service.js';

export interface TransparencySocketDeps {
  transparencyService: TransparencyService;
  getContactIds: (userId: string) => Promise<string[]>;
}

const requestIdSchema = z.string().min(1).max(64).optional();
const userIdSchema = z.string().trim().min(1).max(64);
const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const sizeSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const getHeadSchema = z.object({ requestId: requestIdSchema }).optional();
const getProofsSchema = z.object({
  requestId: requestIdSchema,
  items: z
    .array(
      z.object({
        userId: userIdSchema,
        publicKey: z.string().min(1).max(200),
        signingPublicKey: base64UrlSchema.max(64).optional(),
      }),
    )
    .min(1)
    .max(MAX_PROOF_ITEMS),
});
const getConsistencySchema = z.object({ requestId: requestIdSchema, first: sizeSchema, second: sizeSchema });
const auditSchema = z.object({ requestId: requestIdSchema, fromVersion: z.number().int().min(1).max(1_000_000).optional() }).optional();
const gossipSchema = z.object({ to: userIdSchema, envelope: base64UrlSchema.min(1).max(MAX_GOSSIP_ENVELOPE_LENGTH) });

registerClientEvents('key-transparency', {
  'kt:get-head': getHeadSchema,
  'kt:get-proofs': getProofsSchema,
  'kt:get-consistency': getConsistencySchema,
  'kt:audit': auditSchema,
  'kt:gossip': gossipSchema,
});

registerServerEvents('key-transparency', ['kt:config', 'kt:head', 'kt:proofs', 'kt:consistency', 'kt:audit', 'kt:gossip']);

export function registerTransparencySocketHandlers(socket: AppSocket, deps: TransparencySocketDeps): void {
  const { transparencyService } = deps;

  socket.on('kt:get-head', (payload) => {
    runAuthedSocketHandler(socket, 'kt:get-head', async () => {
      const input = getHeadSchema.parse(payload);
      const head = await transparencyService.head();
      socket.emit('kt:head', { ...(input?.requestId ? { requestId: input.requestId } : {}), head });
    });
  });

  socket.on('kt:get-proofs', (payload) => {
    runAuthedSocketHandler(socket, 'kt:get-proofs', async () => {
      const input = getProofsSchema.parse(payload);
      const { head, proofs } = await transparencyService.proofs(input.items);
      socket.emit('kt:proofs', { ...(input.requestId ? { requestId: input.requestId } : {}), head, proofs });
    });
  });

  socket.on('kt:get-consistency', (payload) => {
    runAuthedSocketHandler(socket, 'kt:get-consistency', async () => {
      const input = getConsistencySchema.parse(payload);
      const proof = await transparencyService.consistency(input.first, input.second);
      if (!proof) {
        throw AppError.of('e2e.transparencyInvalid');
      }
      socket.emit('kt:consistency', {
        ...(input.requestId ? { requestId: input.requestId } : {}),
        first: input.first,
        second: input.second,
        proof: proof === 'beyond' ? null : proof,
      });
    });
  });

  socket.on('kt:audit', (payload) => {
    runAuthedSocketHandler(socket, 'kt:audit', async (userId) => {
      const input = auditSchema.parse(payload);
      const result = await transparencyService.audit(userId, input?.fromVersion ?? 1);
      socket.emit('kt:audit', { ...(input?.requestId ? { requestId: input.requestId } : {}), ...result });
    });
  });

  socket.on('kt:gossip', (payload) => {
    runAuthedSocketHandler(socket, 'kt:gossip', async (userId) => {
      const input = gossipSchema.parse(payload);
      const contacts = await deps.getContactIds(userId);
      if (input.to === userId || !contacts.includes(input.to)) {
        throw AppError.of('e2e.transparencyInvalid');
      }
      socket.to(userRoom(input.to)).emit('kt:gossip', { from: userId, envelope: input.envelope });
    });
  });
}
