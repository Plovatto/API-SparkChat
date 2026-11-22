import { z } from 'zod';

export const idSchema = z.string().trim().min(1);

export const roomIdPayloadSchema = z.object({
  roomId: idSchema,
});
