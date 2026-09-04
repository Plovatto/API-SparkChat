import { z } from 'zod';

const MAX_PUBLIC_KEY_LENGTH = 200;
const MAX_WRAPPED_KEY_LENGTH = 2000;

export const publishE2eKeysPayloadSchema = z
  .object({
    publicKey: z.string().trim().min(1).max(MAX_PUBLIC_KEY_LENGTH).optional(),
    encryptedPrivateKeyByPassword: z.string().trim().min(1).max(MAX_WRAPPED_KEY_LENGTH).optional(),
    encryptedPrivateKeyByRecovery: z.string().trim().min(1).max(MAX_WRAPPED_KEY_LENGTH).optional(),
  })
  .refine(
    (data) =>
      data.publicKey !== undefined ||
      data.encryptedPrivateKeyByPassword !== undefined ||
      data.encryptedPrivateKeyByRecovery !== undefined,
    { message: 'Nenhuma chave informada.' },
  );


export const getPublicKeysPayloadSchema = z.object({
  userIds: z.array(z.string().trim().min(1)).min(1).max(200),
});

