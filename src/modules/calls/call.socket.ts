import { z } from 'zod';
import { registerClientEvents, registerServerEvents } from '../../docs/socket-registry.js';
import type { AppSocket } from '../../sockets/events.js';
import { extractErrorPayload } from '../../sockets/socket-errors.js';
import { runSocketHandler } from '../../sockets/socket-handler.js';
import { requireSocketUserId } from '../../sockets/socket-session.js';
import type { CallActor, CallService } from './call.service.js';
import { CALL_ID_PATTERN } from './call.types.js';

export interface CallSocketDeps {
  callService: CallService;
}

const callIdSchema = z.string().regex(CALL_ID_PATTERN).openapi({ description: '16 bytes aleatórios em base64url sem preenchimento' });
const envelopeSchema = z.string().min(1).openapi({ description: 'Texto opaco para o servidor; no máximo 16 KB' });
const kindSchema = z.enum(['voice', 'video']);
const degradeSchema = z.enum(['none', 'video-360', 'audio-only-relay']);
const endReasonSchema = z.enum(['completed', 'missed', 'declined', 'cancelled', 'busy', 'failed', 'connection-lost']);
const iceServerSchema = z.object({ urls: z.array(z.string()), username: z.string().optional(), credential: z.string().optional() });

const startPayloadSchema = z.object({ callId: callIdSchema, roomId: z.string().trim().min(1), kind: kindSchema, envelope: envelopeSchema });
const acceptPayloadSchema = z.object({ callId: callIdSchema, envelope: envelopeSchema });
const callIdPayloadSchema = z.object({ callId: callIdSchema });
const signalPayloadSchema = z.object({ callId: callIdSchema, to: z.string().trim().min(1), envelope: envelopeSchema });
const syncPayloadSchema = z.object({}).optional();
const iceServersPayloadSchema = z.object({ callId: callIdSchema, protectIp: z.boolean() });

registerClientEvents('calls', {
  'call:start': startPayloadSchema,
  'call:accept': acceptPayloadSchema,
  'call:decline': callIdPayloadSchema,
  'call:silence': callIdPayloadSchema,
  'call:hangup': callIdPayloadSchema,
  'call:signal': signalPayloadSchema,
  'call:heartbeat': callIdPayloadSchema,
  'call:sync': syncPayloadSchema,
  'call:ice-servers': iceServersPayloadSchema,
});

registerServerEvents(
  'calls',
  [
    'call:config',
    'call:incoming',
    'call:accepted',
    'call:answered-elsewhere',
    'call:declined-elsewhere',
    'call:signal',
    'call:ended',
    'call:state',
    'call:ice-servers-result',
  ],
  {
    'call:config': z.object({ enabled: z.boolean(), relayAvailable: z.boolean(), degrade: degradeSchema }),
    'call:incoming': z.object({
      callId: callIdSchema,
      roomId: z.string(),
      kind: kindSchema,
      callerId: z.string(),
      envelope: envelopeSchema,
      ringExpiresAt: z.string(),
    }),
    'call:accepted': z.object({ callId: callIdSchema, envelope: envelopeSchema, deviceId: z.string() }),
    'call:answered-elsewhere': callIdPayloadSchema,
    'call:declined-elsewhere': callIdPayloadSchema,
    'call:signal': z.object({ callId: callIdSchema, from: z.string(), envelope: envelopeSchema }),
    'call:ended': z.object({ callId: callIdSchema, reason: endReasonSchema, endedAt: z.string() }),
    'call:state': z
      .object({
        callId: callIdSchema,
        state: z.enum(['ringing', 'accepted', 'active']),
        roomId: z.string(),
        kind: kindSchema,
        peerId: z.string(),
        role: z.enum(['caller', 'callee']),
      })
      .nullable(),
    'call:ice-servers-result': z.object({
      callId: callIdSchema,
      iceServers: z.array(iceServerSchema),
      expiresAt: z.string(),
      relayOnly: z.boolean(),
      degrade: degradeSchema,
    }),
  },
);

function actorOf(socket: AppSocket): CallActor | null {
  const userId = requireSocketUserId(socket);
  return userId ? { userId, socketId: socket.id } : null;
}

function handle(socket: AppSocket, event: string, work: (actor: CallActor) => Promise<void>): void {
  runSocketHandler(socket, event, async () => {
    const actor = actorOf(socket);
    if (!actor) {
      return;
    }
    try {
      await work(actor);
    } catch (error) {
      socket.emit('error', { ...extractErrorPayload(error), event });
    }
  });
}

export function registerCallSocketHandlers(socket: AppSocket, deps: CallSocketDeps): void {
  const { callService } = deps;

  socket.on('call:start', (payload) => {
    handle(socket, 'call:start', (actor) => callService.start(actor, startPayloadSchema.parse(payload)));
  });

  socket.on('call:accept', (payload) => {
    handle(socket, 'call:accept', (actor) => callService.accept(actor, acceptPayloadSchema.parse(payload)));
  });

  socket.on('call:decline', (payload) => {
    handle(socket, 'call:decline', (actor) => callService.decline(actor, callIdPayloadSchema.parse(payload).callId));
  });

  socket.on('call:silence', (payload, ack) => {
    handle(socket, 'call:silence', async (actor) => {
      await callService.silence(actor, callIdPayloadSchema.parse(payload).callId);
      ack?.();
    });
  });

  socket.on('call:hangup', (payload) => {
    handle(socket, 'call:hangup', (actor) => callService.hangup(actor, callIdPayloadSchema.parse(payload).callId));
  });

  socket.on('call:signal', (payload) => {
    handle(socket, 'call:signal', (actor) => callService.signal(actor, signalPayloadSchema.parse(payload)));
  });

  socket.on('call:heartbeat', (payload) => {
    handle(socket, 'call:heartbeat', (actor) => callService.heartbeat(actor, callIdPayloadSchema.parse(payload).callId));
  });

  socket.on('call:sync', (payload) => {
    handle(socket, 'call:sync', (actor) => {
      syncPayloadSchema.parse(payload);
      return callService.sync(actor);
    });
  });

  socket.on('call:ice-servers', (payload) => {
    handle(socket, 'call:ice-servers', async (actor) => {
      const result = await callService.iceServers(actor, iceServersPayloadSchema.parse(payload));
      socket.emit('call:ice-servers-result', result);
    });
  });
}
