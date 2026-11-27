import { z } from 'zod';
import { STATUS_TEXT_MAX_LENGTH } from '../../users/user.model.js';
import { confirmCard } from '../assistant.confirm.js';
import { defineTool } from '../assistant.toolbox.js';
import { STATUS_MAX_LEAD_MS, STATUS_TEXTS, formatUntil } from '../status.texts.js';
import { relativeMinutesParameter, relativeMinutesSchema, resolveLocalTime } from '../relative-time.js';
import { localToUtc } from '../zoned-time.js';

const schema = z.object({
  text: z
    .string()
    .trim()
    .refine((value) => value.length > 0 && Array.from(value).length <= STATUS_TEXT_MAX_LENGTH),
  untilLocal: z.string().optional(),
  untilInMinutes: relativeMinutesSchema,
});

export function createSetStatusTool() {
  return defineTool({
    declaration: {
      name: 'set_status',
      description: `Asks the person to confirm a temporary status that goes back to the previous one when it ends. text is at most ${STATUS_TEXT_MAX_LENGTH} characters. untilLocal is local time without offset, like 2026-11-27T15:00, at most 7 days ahead. For relative ends (for the next X minutes or hours) pass untilInMinutes instead and never untilLocal; the server computes the time. If the person did not say until when, call without untilLocal (it returns need_time) and then ask them. Never make up a time.`,
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: `The status text, up to ${STATUS_TEXT_MAX_LENGTH} characters.` },
          untilLocal: { type: 'string', description: 'Local end date and time, like 2026-11-27T15:00.' },
          untilInMinutes: relativeMinutesParameter('Minutes from now until the status ends, for relative requests. Use instead of untilLocal.'),
        },
        required: ['text'],
      },
    },
    schema,
    run: (args, ctx) => {
      const resolved = resolveLocalTime(args.untilLocal, args.untilInMinutes, ctx);
      if ('error' in resolved) {
        return Promise.resolve({ response: { error: resolved.error } });
      }
      const until = localToUtc(resolved.local, ctx.timeZone);
      if (until <= ctx.now) {
        return Promise.resolve({ response: { error: 'too_soon' } });
      }
      if (until > ctx.now + STATUS_MAX_LEAD_MS) {
        return Promise.resolve({ response: { error: 'too_far' } });
      }
      const summary = STATUS_TEXTS.confirmSummary(args.text, formatUntil(until, ctx.now, ctx.timeZone, ctx.locale), ctx.locale);
      return Promise.resolve({
        response: { awaitingConfirmation: true, summary },
        card: confirmCard({ type: 'status', text: args.text, untilLocal: resolved.local, timeZone: ctx.timeZone }, ctx.locale),
      });
    },
  });
}
