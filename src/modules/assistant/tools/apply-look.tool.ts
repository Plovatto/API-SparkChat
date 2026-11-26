import { defineTool } from '../assistant.toolbox.js';
import { isLookEmpty, sanitizeLook } from '../look.catalog.js';
import { describeLook, type LookService } from '../look.service.js';
import { LOOK_APPLIED_BUTTONS } from '../look.texts.js';
import { LOOK_PARAMETERS, lookArgsSchema, lookFromArgs } from './look.schema.js';

export function createApplyLookTool(looks: LookService) {
  return defineTool({
    declaration: {
      name: 'apply_look',
      description:
        'Applies a look right away (theme, wallpaper, bubble or background adjustments, or any combination) for all conversations and shows a card with an undo button. Use when they ask you to pick or apply a look for them. Use only ids from the catalog.',
      parameters: LOOK_PARAMETERS,
    },
    schema: lookArgsSchema,
    run: async (args, ctx) => {
      const { look, rejected } = sanitizeLook(lookFromArgs(args));
      if (isLookEmpty(look)) {
        return { response: { error: 'nothing_valid', rejected } };
      }
      const { previous } = await looks.applyLook(ctx.io, ctx.userId, look);
      return {
        response: { applied: look, rejected, description: describeLook(look, ctx.locale), reason: args.reason },
        card: { v: 1, kind: 'look-applied', look, previous, buttons: LOOK_APPLIED_BUTTONS[ctx.locale] },
      };
    },
  });
}
