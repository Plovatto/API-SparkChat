import { z } from 'zod';

export const roomIdPayloadSchema = z.object({
  roomId: z.string().trim().min(1),
});
