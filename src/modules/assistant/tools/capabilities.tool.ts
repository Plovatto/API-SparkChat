import { z } from 'zod';
import { defineTool } from '../assistant.toolbox.js';

export const capabilitiesTool = defineTool({
  declaration: {
    name: 'show_capabilities',
    description: 'Shows the person a card listing what SparkAI can do. Use when they ask what you can do or how you can help.',
  },
  schema: z.object({}),
  run: () => Promise.resolve({ response: { shown: true }, card: { v: 1, kind: 'capabilities' } }),
});
