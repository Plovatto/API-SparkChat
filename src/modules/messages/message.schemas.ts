import { z } from 'zod';
import '../../docs/zod-extend.js';
import { quickReplySchema } from '../assistant/assistant.card.js';
import { SYSTEM_EVENT_TYPES } from './message.system-events.js';

const messageTypeSchema = z.enum(['text', 'system', 'image', 'audio', 'file', 'error']);

export const messageSenderSchema = z.object({
  id: z.string(),
  nickname: z.string(),
  avatar: z.number().int().nullable(),
  unknown: z.literal(true).optional().openapi({ description: 'Presente quando o remetente não existe mais' }),
});

export const systemEventSchema = z
  .object({
    type: z.enum(SYSTEM_EVENT_TYPES),
    params: z.record(z.string(), z.string().nullable()),
  })
  .openapi({ example: { type: 'group.created', params: { actor: 'Fulana' } } });

const messageFileMetaSchema = z.object({
  name: z.string(),
  mimeType: z.string(),
  size: z.number(),
  thumbnailUrl: z.string().optional(),
  key: z.string().optional().openapi({ description: 'Chave do anexo (32 bytes) cifrada como campo e2e:v2 da mensagem; o servidor nunca vê o valor em claro' }),
  thumbnailKey: z.string().optional().openapi({ description: 'Chave da miniatura, cifrada como campo e2e:v2 da mensagem' }),
  previewKey: z.string().optional().openapi({ description: 'Chave da imagem da prévia de link, cifrada como campo e2e:v2 da mensagem' }),
});

const messageLinkPreviewSchema = z.object({
  url: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  siteName: z.string().nullable(),
});

const messageReplySnapshotSchema = z.object({
  id: z.string(),
  content: z.string(),
  type: messageTypeSchema,
  duration: z.number().nullable(),
  fileMeta: messageFileMetaSchema.nullable(),
  caption: z.string().nullable(),
  sender: messageSenderSchema,
  deleted: z.boolean().openapi({
    description: 'true quando a mensagem original foi apagada para todos; nesse caso content fica vazio e duration, fileMeta e caption ficam nulos',
  }),
});

export const messageReactionSchema = z.object({
  userId: z.string(),
  emoji: z.string().openapi({ description: 'Emoji da reação cifrado como campo e2e:v2 com a chave da sala; o servidor nunca vê o emoji em claro' }),
  updatedAt: z.string(),
});

export const messageViewSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  sender: messageSenderSchema,
  content: z.string(),
  type: messageTypeSchema,
  duration: z.number().nullable(),
  timestamp: z.string(),
  deletedForEveryone: z.boolean(),
  status: z.enum(['sent', 'delivered', 'read']),
  deliveredTo: z.array(z.string()),
  readBy: z.array(z.string()),
  playedBy: z.array(z.string()),
  replyTo: messageReplySnapshotSchema.nullable(),
  mentionedUserIds: z.array(z.string()),
  fileMeta: messageFileMetaSchema.nullable(),
  caption: z.string().nullable(),
  linkPreview: messageLinkPreviewSchema.nullable(),
  systemEvent: systemEventSchema.nullable(),
  assistantCard: z.string().optional().openapi({ description: 'Cartão do SparkAI selado com a chave da sala (e2e:v2); produzido só pelo servidor' }),
  quickReply: quickReplySchema.optional().openapi({ description: 'Resposta a um cartão do SparkAI; só existe em mensagens da sala do SparkAI' }),
  reactions: z.array(messageReactionSchema).openapi({
    description: 'Reações à mensagem, no máximo uma por pessoa, ordenadas por updatedAt; vazio para mensagens apagadas para todos e de sistema',
  }),
});

export const messageReactionsUpdatedPayloadSchema = z.object({
  roomId: z.string(),
  messageId: z.string(),
  messageTimestamp: z.string().openapi({ description: 'Horário da mensagem reagida; nenhuma reação é anterior a ele' }),
  reactions: z.array(messageReactionSchema),
});

export const newMessagePayloadSchema = messageViewSchema.extend({
  clientTempId: z.string().optional(),
});

export const messagesListPayloadSchema = z.object({
  roomId: z.string(),
  messages: z.array(messageViewSchema),
  hasMore: z.boolean(),
});

export const messageHiddenPayloadSchema = z.object({
  roomId: z.string(),
  messageIds: z.array(z.string()).openapi({ description: 'Mensagens escondidas só para quem pediu; enviado a todos os aparelhos dessa pessoa' }),
  lastMessage: messageViewSchema.nullable().openapi({ description: 'Nova prévia da última mensagem visível da sala para essa pessoa' }),
  unreadCount: z.number().int(),
  mentionCount: z.number().int(),
});
