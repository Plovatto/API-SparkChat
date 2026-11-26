import { defineTool } from '../assistant.toolbox.js';
import { isLookEmpty, sanitizeLook } from '../look.catalog.js';
import { LOOK_SUGGESTION_BUTTONS } from '../look.texts.js';
import { LOOK_PARAMETERS, lookArgsSchema, lookFromArgs } from './look.schema.js';

export const suggestLookTool = defineTool({
  declaration: {
    name: 'suggest_look',
    description:
      'Shows the person a preview card of a suggested look (theme, wallpaper, bubble or background adjustments, or any combination) with buttons to apply it. Use when they ask you to suggest a look. Use only ids from the catalog.',
    parameters: LOOK_PARAMETERS,
  },
  schema: lookArgsSchema,
  run: (args, ctx) => {
    const { look, rejected } = sanitizeLook(lookFromArgs(args));
    if (isLookEmpty(look)) {
      return Promise.resolve({ response: { error: 'nothing_valid', rejected } });
    }
    return Promise.resolve({
      response: { suggested: look, rejected, reason: args.reason },
      card: { v: 1, kind: 'look-suggestion', look, buttons: LOOK_SUGGESTION_BUTTONS[ctx.locale] },
    });
  },
});
