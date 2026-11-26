import { z } from 'zod';
import type { AssistantLook } from '../assistant.card.js';

export const lookArgsSchema = z.object({
  baseTheme: z.string().optional(),
  colorTheme: z.string().optional(),
  wallpaper: z.string().optional(),
  appearance: z
    .object({
      overlayOpacity: z.number().optional(),
      overlayBlur: z.number().optional(),
      ownBubbleColor: z.string().nullable().optional(),
      ownBubbleOpacity: z.number().optional(),
      ownTextIntensity: z.number().nullable().optional(),
      otherBubbleColor: z.string().nullable().optional(),
      otherBubbleOpacity: z.number().optional(),
      otherTextIntensity: z.number().nullable().optional(),
      bubbleBlur: z.number().optional(),
    })
    .optional(),
  reason: z.string().max(300),
});

export type LookArgs = z.infer<typeof lookArgsSchema>;

export const LOOK_PARAMETERS = {
  type: 'object',
  properties: {
    baseTheme: { type: 'string', description: 'Base theme id from the catalog.' },
    colorTheme: { type: 'string', description: 'Color theme id from the catalog.' },
    wallpaper: { type: 'string', description: 'Wallpaper id from the catalog.' },
    appearance: {
      type: 'object',
      description: 'Bubble and background adjustments, only the fields that change, inside the catalog ranges.',
      properties: {
        overlayOpacity: { type: 'number' },
        overlayBlur: { type: 'number' },
        ownBubbleColor: { type: 'string', nullable: true },
        ownBubbleOpacity: { type: 'number' },
        ownTextIntensity: { type: 'number', nullable: true },
        otherBubbleColor: { type: 'string', nullable: true },
        otherBubbleOpacity: { type: 'number' },
        otherTextIntensity: { type: 'number', nullable: true },
        bubbleBlur: { type: 'number' },
      },
    },
    reason: { type: 'string', description: 'One short sentence on why this look fits the request.' },
  },
  required: ['reason'],
};

export function lookFromArgs(args: LookArgs): AssistantLook {
  const { reason: _reason, ...look } = args;
  return look as AssistantLook;
}
