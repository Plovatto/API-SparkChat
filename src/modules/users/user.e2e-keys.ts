import { z } from 'zod';
import { E2E_LOOKUP_MAX_ITEMS } from '../../sockets/id-lookup.js';

const MAX_PUBLIC_KEY_LENGTH = 200;
const MAX_WRAPPED_KEY_LENGTH = 2000;

export const wrappedPrivateKeySchema = z.string().trim().min(1).max(MAX_WRAPPED_KEY_LENGTH);

export const publishE2eKeysPayloadSchema = z
  .object({
    publicKey: z.string().trim().min(1).max(MAX_PUBLIC_KEY_LENGTH).optional(),
    encryptedPrivateKeyByPassword: wrappedPrivateKeySchema.optional(),
    encryptedPrivateKeyByRecovery: wrappedPrivateKeySchema.optional(),
  })
  .refine(
    (data) =>
      data.publicKey !== undefined ||
      data.encryptedPrivateKeyByPassword !== undefined ||
      data.encryptedPrivateKeyByRecovery !== undefined,
    { message: 'Nenhuma chave informada.' },
  );


export const publishSigningKeyPayloadSchema = z.object({
  signingPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  keySignature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

export const getPublicKeysPayloadSchema = z.object({
  userIds: z.array(z.string().trim().min(1)).min(1).max(E2E_LOOKUP_MAX_ITEMS),
});

