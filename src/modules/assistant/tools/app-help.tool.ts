import { z } from 'zod';
import { HELP_TOPICS } from '../assistant.card.js';
import { HELP_CATALOG } from '../assistant.help-catalog.js';
import { defineTool } from '../assistant.toolbox.js';

export const appHelpTool = defineTool({
  declaration: {
    name: 'app_help',
    description:
      'Explains how to use a SparkChat feature and shows a card with a button that opens the right screen. Use when the person asks how to do something in the app.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: [...HELP_TOPICS], description: 'The feature the person asks about.' },
      },
      required: ['topic'],
    },
  },
  schema: z.object({ topic: z.enum(HELP_TOPICS) }),
  run: ({ topic }, ctx) => {
    const entry = HELP_CATALOG[topic];
    return Promise.resolve({
      response: { topic, explanation: entry.text[ctx.locale] },
      card: { v: 1, kind: 'help', topic, target: entry.target },
    });
  },
});
