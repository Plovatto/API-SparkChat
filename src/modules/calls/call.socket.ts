import { z } from 'zod';
import { registerClientEvents, registerServerEvents } from '../../docs/socket-registry.js';
import { AppError, errorPayload } from '../../lib/app-error.js';
import type { AppSocket } from '../../sockets/events.js';
import { extractErrorPayload } from '../../sockets/socket-errors.js';
import { runSocketHandler } from '../../sockets/socket-handler.js';
import { requireSocketUserId } from '../../sockets/socket-session.js';
import type { CallActor, CallService } from './call.service.js';
import { CALL_ID_PATTERN, MAX_ENVELOPE_LENGTH } from './call.types.js';

export interface CallSocketDeps {
  callService: CallService;
}

const callIdSchema = z.string().regex(CALL_ID_PATTERN).openapi({ description: '16 bytes aleatórios em base64url sem preenchimento' });
const envelopeSchema = z.string().min(1).max(MAX_ENVELOPE_LENGTH).openapi({ description: 'Texto opaco para o servidor; no máximo 16 KB' });
const kindSchema = z.enum(['voice', 'video']);
const degradeSchema = z.enum(['none', 'video-360', 'audio-only-relay']);
const endReasonSchema = z.enum(['completed', 'missed', 'declined', 'cancelled', 'busy', 'failed', 'connection-lost']);
const iceServerSchema = z.object({ urls: z.array(z.string()), username: z.string().optional(), credential: z.string().optional() });

const deviceSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,64}$/)
  .openapi({ description: 'Token aleatório da aba, guardado só nela. Uma aba que volta num socket novo (troca de rede ou recarga) com o mesmo token é reconhecida como o mesmo aparelho' });
const startPayloadSchema = z.object({ callId: callIdSchema, roomId: z.string().trim().min(1), kind: kindSchema, envelope: envelopeSchema, device: deviceSchema.optional() });
const acceptPayloadSchema = z.object({ callId: callIdSchema, envelope: envelopeSchema, device: deviceSchema.optional() });
const callIdPayloadSchema = z.object({ callId: callIdSchema });
const mediaStateSchema = z
  .object({ muted: z.boolean(), camera: z.boolean() })
  .openapi({ description: 'Estado do microfone e da câmera deste aparelho. O servidor só repassa aos outros aparelhos da mesma conta, para que uma troca de aparelho mantenha o mesmo estado' });
const heartbeatPayloadSchema = z.object({ callId: callIdSchema, relayed: z.boolean().optional().openapi({ description: 'Rota atual da mídia deste aparelho. false (conexão direta) faz o servidor revogar as credenciais TURN deste aparelho; um novo call:ice-servers emite outras quando precisar do relay' }), media: mediaStateSchema.optional(), device: deviceSchema.optional() });
const hangupPayloadSchema = z.object({ callId: callIdSchema, force: z.boolean().optional() });
const signalPayloadSchema = z.object({ callId: callIdSchema, to: z.string().trim().min(1), envelope: envelopeSchema });
const syncPayloadSchema = z
  .object({
    callId: callIdSchema.nullable().optional().openapi({ description: 'Chamada em que este aparelho está agora (null se nenhuma). Só um aparelho que informa esta chamada assume o vínculo dela no sync; sem o campo, vale o comportamento antigo' }),
    device: deviceSchema.optional(),
  })
  .optional();
const iceServersPayloadSchema = z.object({ callId: callIdSchema, protectIp: z.boolean() });
const transferPayloadSchema = z.object({ callId: callIdSchema, envelope: envelopeSchema, device: deviceSchema.optional() });

registerClientEvents('calls', {
  'call:start': startPayloadSchema,
  'call:accept': acceptPayloadSchema,
  'call:decline': callIdPayloadSchema,
  'call:silence': callIdPayloadSchema,
  'call:hangup': hangupPayloadSchema,
  'call:signal': signalPayloadSchema,
  'call:heartbeat': heartbeatPayloadSchema,
  'call:sync': syncPayloadSchema,
  'call:ice-servers': iceServersPayloadSchema,
  'call:transfer': transferPayloadSchema,
  'call:transfer-accept': transferPayloadSchema,
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
    'call:transferred',
    'call:peer-transfer',
    'call:transfer-accepted',
    'call:transfer-failed',
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
        answeredAt: z.string().nullable(),
        resumable: z.literal(true).optional().openapi({ description: 'Presente quando esta é a mesma aba que estava na chamada (mesmo token de aba), por exemplo depois de recarregar a página. O cliente retoma a chamada sozinho em vez de mostrar outro aparelho' }),
        transferable: z.boolean().openapi({ description: 'true quando este aparelho pode puxar a chamada que está ativa em outro aparelho da mesma conta' }),
        peerLive: z.boolean().openapi({ description: 'true enquanto o outro participante ainda pode voltar: o socket dele segue conectado ou ele deu sinal de vida há menos de 3 minutos. O cliente usa isso para continuar reconectando em vez de encerrar' }),
        media: mediaStateSchema.optional().openapi({ description: 'Último estado de microfone e câmera informado pelo aparelho desta conta que está na chamada. Ausente enquanto ele não informou' }),
      })
      .nullable(),
    'call:transferred': callIdPayloadSchema,
    'call:peer-transfer': z.object({ callId: callIdSchema, from: z.string(), envelope: envelopeSchema }),
    'call:transfer-accepted': z.object({ callId: callIdSchema, envelope: envelopeSchema }),
    'call:transfer-failed': callIdPayloadSchema,
    'call:ice-servers-result': z.object({
      callId: callIdSchema,
      iceServers: z.array(iceServerSchema),
      expiresAt: z.string(),
      relayOnly: z.boolean(),
      degrade: degradeSchema,
    }),
  },
);

function isOversizedEnvelope(error: unknown): boolean {
  return error instanceof z.ZodError && error.issues.some((issue) => issue.code === 'too_big' && issue.path.at(-1) === 'envelope');
}

function actorOf(socket: AppSocket): CallActor | null {
  const userId = requireSocketUserId(socket);
  return userId ? { userId, socketId: socket.id } : null;
}

const MAX_QUEUED_EVENTS = 64;

function createSequentialHandler(socket: AppSocket) {
  let tail: Promise<void> = Promise.resolve();
  let queued = 0;

  return (event: string, work: (actor: CallActor) => Promise<void>): void => {
    if (queued >= MAX_QUEUED_EVENTS) {
      socket.emit('error', { ...errorPayload('call.rateLimited'), event });
      return;
    }
    queued += 1;
    const run = async (): Promise<void> => {
      try {
        const actor = actorOf(socket);
        if (!actor) {
          return;
        }
        try {
          await work(actor);
        } catch (error) {
          socket.emit('error', { ...extractErrorPayload(isOversizedEnvelope(error) ? AppError.of('call.signalTooLarge') : error), event });
        }
      } finally {
        queued -= 1;
      }
    };
    tail = tail.then(() => new Promise<void>((resolve) => {
      runSocketHandler(socket, event, () => run().finally(resolve));
    }));
  };
}

export function registerCallSocketHandlers(socket: AppSocket, deps: CallSocketDeps): void {
  const { callService } = deps;
  const handle = createSequentialHandler(socket);

  socket.on('call:start', (payload) => {
    handle('call:start', (actor) => {
      const input = startPayloadSchema.parse(payload);
      callService.noteDevice(actor, input.device);
      return callService.start(actor, input);
    });
  });

  socket.on('call:accept', (payload) => {
    handle('call:accept', (actor) => {
      const input = acceptPayloadSchema.parse(payload);
      callService.noteDevice(actor, input.device);
      return callService.accept(actor, input);
    });
  });

  socket.on('call:decline', (payload) => {
    handle('call:decline', (actor) => callService.decline(actor, callIdPayloadSchema.parse(payload).callId));
  });

  socket.on('call:silence', (payload, ack) => {
    handle('call:silence', async (actor) => {
      await callService.silence(actor, callIdPayloadSchema.parse(payload).callId);
      ack?.();
    });
  });

  socket.on('call:hangup', (payload) => {
    handle('call:hangup', (actor) => {
      const input = hangupPayloadSchema.parse(payload);
      return callService.hangup(actor, input.callId, input.force === true);
    });
  });

  socket.on('call:signal', (payload) => {
    handle('call:signal', (actor) => callService.signal(actor, signalPayloadSchema.parse(payload)));
  });

  socket.on('call:heartbeat', (payload) => {
    handle('call:heartbeat', (actor) => {
      const input = heartbeatPayloadSchema.parse(payload);
      callService.noteDevice(actor, input.device);
      return callService.heartbeat(actor, input.callId, input.relayed, input.media);
    });
  });

  socket.on('call:sync', (payload) => {
    handle('call:sync', (actor) => {
      const input = syncPayloadSchema.parse(payload);
      callService.noteDevice(actor, input?.device);
      return callService.sync(actor, input?.callId);
    });
  });

  socket.on('call:transfer', (payload) => {
    handle('call:transfer', (actor) => {
      const input = transferPayloadSchema.parse(payload);
      callService.noteDevice(actor, input.device);
      return callService.transfer(actor, input);
    });
  });

  socket.on('call:transfer-accept', (payload) => {
    handle('call:transfer-accept', (actor) => callService.transferAccept(actor, transferPayloadSchema.parse(payload)));
  });

  socket.on('call:ice-servers', (payload) => {
    handle('call:ice-servers', async (actor) => {
      const result = await callService.iceServers(actor, iceServersPayloadSchema.parse(payload));
      socket.emit('call:ice-servers-result', result);
    });
  });
}
