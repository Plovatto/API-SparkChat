import { z } from 'zod';
import { E2E_LOOKUP_MAX_ITEMS } from '../../sockets/id-lookup.js';
import { idSchema } from '../../sockets/payloads.js';

const MAX_WRAPPED_KEY_LENGTH = 2000;

export const wrappedPrivateKeySchema = z.string().trim().min(1).max(MAX_WRAPPED_KEY_LENGTH);

const identityPublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const signingPublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const keySignatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/);

export const publishE2eKeysPayloadSchema = z
  .object({
    signingPublicKey: signingPublicKeySchema.optional(),
    keySignature: keySignatureSchema.optional(),
    publicKey: identityPublicKeySchema.optional(),
    encryptedPrivateKeyByPassword: wrappedPrivateKeySchema.optional(),
    encryptedPrivateKeyByRecovery: wrappedPrivateKeySchema.optional(),
  })
  .refine(
    (data) =>
      data.publicKey !== undefined ||
      data.signingPublicKey !== undefined ||
      data.encryptedPrivateKeyByPassword !== undefined ||
      data.encryptedPrivateKeyByRecovery !== undefined,
    { message: 'Nenhuma chave informada.' },
  )
  .refine((data) => (data.signingPublicKey === undefined) === (data.keySignature === undefined), {
    message: 'Informe a chave de assinatura e a assinatura juntas.',
  });


export const publishSigningKeyPayloadSchema = z.object({
  signingPublicKey: signingPublicKeySchema,
  keySignature: keySignatureSchema,
});

export const getPublicKeysPayloadSchema = z.object({
  userIds: z.array(idSchema).min(1).max(E2E_LOOKUP_MAX_ITEMS),
});

