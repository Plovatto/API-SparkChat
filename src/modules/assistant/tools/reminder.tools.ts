import { z } from 'zod';
import type { Recurrence } from '../assistant.card.js';
import { confirmCard } from '../assistant.confirm.js';
import { defineTool, type AssistantContext, type ToolResult } from '../assistant.toolbox.js';
import { ASSISTANT_TEXTS, confirmSummary, formatWhen, truncate } from '../reminder.texts.js';
import { REMINDER_MAX_LEAD_MS, REMINDER_MIN_LEAD_MS, REMINDER_TEXT_MAX_LENGTH, type RemindersService } from '../reminders.service.js';
import { localToUtc, parseLocalDateTime } from '../zoned-time.js';

const PREVIEW_LENGTH = 80;

export const recurrenceSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly']),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  interval: z.number().int().min(1).max(12).optional(),
});

type CreateArgs = { text: string; whenLocal?: string | undefined; recurrence?: z.infer<typeof recurrenceSchema> | undefined };

function toRecurrence(parsed: z.infer<typeof recurrenceSchema> | undefined): Recurrence | null {
  if (!parsed) {
    return null;
  }
  return { freq: parsed.freq, ...(parsed.weekdays ? { weekdays: parsed.weekdays } : {}), ...(parsed.interval ? { interval: parsed.interval } : {}) };
}

export const RECURRENCE_PARAMETERS = {
  type: 'object',
  description: 'Only when the person wants it to repeat. weekdays uses 0 for Sunday through 6 for Saturday.',
  properties: {
    freq: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
    weekdays: { type: 'array', items: { type: 'integer' } },
    interval: { type: 'integer' },
  },
  required: ['freq'],
};

function evaluate({ text, whenLocal, recurrence: rawRecurrence }: CreateArgs, ctx: AssistantContext): ToolResult {
  const recurrence = toRecurrence(rawRecurrence);
  const clean = text.trim();
  if (clean.length === 0) {
    return { response: { error: 'empty' } };
  }
  if (!whenLocal) {
    return { response: { error: 'need_time' } };
  }
  if (!parseLocalDateTime(whenLocal)) {
    return { response: { error: 'invalid_time' } };
  }
  const fireAt = localToUtc(whenLocal, ctx.timeZone);
  if (fireAt < ctx.now + REMINDER_MIN_LEAD_MS) {
    return { response: { error: 'too_soon' } };
  }
  if (fireAt > ctx.now + REMINDER_MAX_LEAD_MS) {
    return { response: { error: 'too_far' } };
  }
  const summary = confirmSummary(clean, formatWhen(fireAt, ctx.timeZone, ctx.locale), recurrence, ctx.locale);
  return {
    response: { awaitingConfirmation: true, summary },
    card: confirmCard({ type: 'reminder', text: clean, fireAtLocal: whenLocal, timeZone: ctx.timeZone, recurrence }, ctx.locale),
  };
}

export function createCreateReminderTool() {
  return defineTool({
    declaration: {
      name: 'create_reminder',
      description:
        'Asks the person to confirm a reminder. whenLocal is local time without offset, like 2026-11-27T09:00. If the person did not say when, call without whenLocal and then ask them for the time. Never make up a time.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to remind the person about.' },
          whenLocal: { type: 'string', description: 'Local date and time, like 2026-11-27T09:00.' },
          recurrence: RECURRENCE_PARAMETERS,
        },
        required: ['text'],
      },
    },
    schema: z.object({ text: z.string().max(REMINDER_TEXT_MAX_LENGTH), whenLocal: z.string().optional(), recurrence: recurrenceSchema.optional() }),
    run: (args, ctx) => Promise.resolve(evaluate(args, ctx)),
  });
}

export function createListRemindersTool(reminders: RemindersService) {
  return defineTool({
    declaration: { name: 'list_reminders', description: 'Shows the active reminders of the person with their ids.' },
    schema: z.object({}),
    run: async (_args, ctx) => {
      const active = await reminders.listActive(ctx.userId);
      const items = active.map((reminder) => ({ id: reminder.id, text: reminder.text, detail: formatWhen(reminder.nextFireAt, reminder.timeZone, ctx.locale) }));
      return {
        response: { reminders: items },
        card: { v: 1, kind: 'list', title: ASSISTANT_TEXTS.remindersTitle[ctx.locale], items },
      };
    },
  });
}

export function createCancelReminderTool(reminders: RemindersService) {
  return defineTool({
    declaration: {
      name: 'cancel_reminder',
      description: 'Asks the person to confirm cancelling a reminder. Use only an id returned by list_reminders.',
      parameters: { type: 'object', properties: { reminderId: { type: 'string' } }, required: ['reminderId'] },
    },
    schema: z.object({ reminderId: z.string() }),
    run: async ({ reminderId }, ctx) => {
      const reminder = await reminders.find(ctx.userId, reminderId);
      if (!reminder || reminder.status !== 'active') {
        return { response: { error: 'not_found' } };
      }
      const preview = truncate(reminder.text, PREVIEW_LENGTH);
      return {
        response: { awaitingConfirmation: true, preview },
        card: confirmCard({ type: 'cancel-reminder', reminderId: reminder.id, preview }, ctx.locale),
      };
    },
  });
}
