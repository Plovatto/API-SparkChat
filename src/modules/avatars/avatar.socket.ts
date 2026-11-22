import '../../docs/zod-extend.js';
import { z } from 'zod';
import { registerClientEvents, registerServerEvents } from '../../docs/socket-registry.js';
import type { AppServer, AppSocket } from '../../sockets/events.js';
import { idSchema } from '../../sockets/payloads.js';
import { runAuthedSocketHandler } from '../../sockets/socket-handler.js';
import { emitToUser, userRoom } from '../../sockets/user-sockets.js';
import { KEY_ID_PATTERN, type RoomService } from '../rooms/index.js';
import {
  MAX_AVATAR_URL_LENGTH,
  MAX_ENCRYPTED_AVATAR_LENGTH,
  MAX_PROFILE_KEY_ENVELOPE_LENGTH,
  MAX_PROFILE_KEY_ENVELOPES,
  MAX_PROFILE_KEY_VERSION,
} from './avatar.limits.js';
import type { AvatarService, ProfileKeysView, RoomAvatarView } from './avatar.service.js';

export interface AvatarSocketDeps {
  avatarService: AvatarService;
  roomService: RoomService;
}

const keyIdSchema = z.string().regex(KEY_ID_PATTERN).openapi({ description: 'keyId da chave atual da sala' });
const urlSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_AVATAR_URL_LENGTH)
  .openapi({ description: 'URL devolvida por POST /api/avatars/upload' });
const encryptedAvatarSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ENCRYPTED_AVATAR_LENGTH)
  .openapi({ description: 'Ponteiro da foto (url, chave do arquivo e tipo) cifrado pelo cliente' });
const envelopeSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PROFILE_KEY_ENVELOPE_LENGTH)
  .openapi({ description: 'Chave de perfil assinada pela dona e cifrada com a chave atual da sala' });

const setUserAvatarPayloadSchema = z.object({
  url: urlSchema,
  encryptedAvatar: encryptedAvatarSchema,
  profileKeyVersion: z
    .number()
    .int()
    .min(1)
    .max(MAX_PROFILE_KEY_VERSION)
    .openapi({ description: 'Versão da chave de perfil usada no ponteiro; igual ou maior que a atual' }),
});

const clearUserAvatarPayloadSchema = z.object({}).optional();

const setRoomAvatarPayloadSchema = z.object({
  roomId: idSchema,
  url: urlSchema,
  encryptedAvatar: encryptedAvatarSchema,
  keyId: keyIdSchema,
});

const clearRoomAvatarPayloadSchema = z.object({ roomId: idSchema });

const publishProfileKeyPayloadSchema = z.object({
  roomId: idSchema,
  keyId: keyIdSchema,
  envelope: envelopeSchema,
});

const rewrapProfileKeysPayloadSchema = z.object({
  roomId: idSchema,
  keyId: keyIdSchema,
  envelopes: z
    .record(idSchema, envelopeSchema)
    .refine((envelopes) => Object.keys(envelopes).length <= MAX_PROFILE_KEY_ENVELOPES, {
      message: `No máximo ${MAX_PROFILE_KEY_ENVELOPES} envelopes.`,
    })
    .openapi({ description: 'Envelope por userId; só grava para quem ainda não tem envelope desta chave' }),
});

const userAvatarUpdatedSchema = z.object({
  userId: z.string(),
  encryptedAvatar: z.string().nullable(),
  profileKeyVersion: z.number().int(),
});

const roomAvatarUpdatedSchema = z.object({
  roomId: z.string(),
  encryptedAvatar: z.string().nullable(),
  keyId: z.string().nullable(),
});

const profileKeysUpdatedSchema = z.object({
  roomId: z.string(),
  keyId: z.string(),
  envelopes: z.record(z.string(), z.string()),
});

registerClientEvents('avatars', {
  'user:set-avatar': setUserAvatarPayloadSchema,
  'user:clear-avatar': clearUserAvatarPayloadSchema,
  'room:set-avatar': setRoomAvatarPayloadSchema,
  'room:clear-avatar': clearRoomAvatarPayloadSchema,
  'room:publish-profile-key': publishProfileKeyPayloadSchema,
  'room:rewrap-profile-keys': rewrapProfileKeysPayloadSchema,
});

registerServerEvents('avatars', ['user:avatar-updated', 'room:avatar-updated', 'room:profile-keys-updated'], {
  'user:avatar-updated': userAvatarUpdatedSchema,
  'room:avatar-updated': roomAvatarUpdatedSchema,
  'room:profile-keys-updated': profileKeysUpdatedSchema,
});

async function membersOf(deps: AvatarSocketDeps, roomId: string): Promise<string[]> {
  const room = await deps.roomService.getRoomById(roomId);
  return room?.participants ?? [];
}

async function announceUserAvatar(io: AppServer, deps: AvatarSocketDeps, view: { userId: string; encryptedAvatar: string | null; profileKeyVersion: number }) {
  const contactIds = await deps.roomService.getContactIds(view.userId);
  io.to(contactIds.map(userRoom)).emit('user:avatar-updated', view);
}

async function announceRoomAvatar(io: AppServer, deps: AvatarSocketDeps, view: RoomAvatarView): Promise<void> {
  for (const memberId of await membersOf(deps, view.roomId)) {
    emitToUser(io, memberId).emit('room:avatar-updated', view);
  }
}

async function announceProfileKeys(io: AppServer, deps: AvatarSocketDeps, view: ProfileKeysView): Promise<void> {
  if (Object.keys(view.envelopes).length === 0) {
    return;
  }
  for (const memberId of await membersOf(deps, view.roomId)) {
    emitToUser(io, memberId).emit('room:profile-keys-updated', view);
  }
}

export function registerAvatarSocketHandlers(io: AppServer, socket: AppSocket, deps: AvatarSocketDeps): void {
  const { avatarService } = deps;

  socket.on('user:set-avatar', (payload) => {
    runAuthedSocketHandler(socket, 'user:set-avatar', async (userId) => {
      const input = setUserAvatarPayloadSchema.parse(payload);
      await announceUserAvatar(io, deps, await avatarService.setUserAvatar(userId, input));
    });
  });

  socket.on('user:clear-avatar', (payload) => {
    runAuthedSocketHandler(socket, 'user:clear-avatar', async (userId) => {
      clearUserAvatarPayloadSchema.parse(payload);
      await announceUserAvatar(io, deps, await avatarService.clearUserAvatar(userId));
    });
  });

  socket.on('room:set-avatar', (payload) => {
    runAuthedSocketHandler(socket, 'room:set-avatar', async (userId) => {
      const input = setRoomAvatarPayloadSchema.parse(payload);
      await announceRoomAvatar(io, deps, await avatarService.setRoomAvatar(userId, input));
    });
  });

  socket.on('room:clear-avatar', (payload) => {
    runAuthedSocketHandler(socket, 'room:clear-avatar', async (userId) => {
      const { roomId } = clearRoomAvatarPayloadSchema.parse(payload);
      await announceRoomAvatar(io, deps, await avatarService.clearRoomAvatar(userId, roomId));
    });
  });

  socket.on('room:publish-profile-key', (payload) => {
    runAuthedSocketHandler(socket, 'room:publish-profile-key', async (userId) => {
      const input = publishProfileKeyPayloadSchema.parse(payload);
      await announceProfileKeys(io, deps, await avatarService.publishProfileKey(userId, input));
    });
  });

  socket.on('room:rewrap-profile-keys', (payload) => {
    runAuthedSocketHandler(socket, 'room:rewrap-profile-keys', async (userId) => {
      const input = rewrapProfileKeysPayloadSchema.parse(payload);
      await announceProfileKeys(io, deps, await avatarService.rewrapProfileKeys(userId, input));
    });
  });
}
