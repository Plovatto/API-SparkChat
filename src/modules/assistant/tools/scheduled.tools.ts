import { z } from 'zod';
import { confirmCard } from '../assistant.confirm.js';
import { defineTool } from '../assistant.toolbox.js';
import { formatWhen, truncate } from '../reminder.texts.js';
import type { ScheduledMessagesService } from '../scheduled.service.js';
import { SCHEDULED_MAX_LEAD_MS, SCHEDULED_MAX_PENDING, SCHEDULED_MIN_LEAD_MS, SCHEDULED_TEXTS, SCHEDULED_TEXT_MAX_LENGTH } from '../scheduled.texts.js';
import { localToUtc, parseLocalDateTime } from '../zoned-time.js';

const PREVIEW_LENGTH = 80;

export interface ScheduleTarget {
  roomId: string;
  nickname: string;
}

export interface ScheduleTargetDirectory {
  listTargets(userId: string): Promise<ScheduleTarget[]>;
}

export function normalizeRecipient(value: string): string {
  return value.trim().toLowerCase();
}

export function createScheduleMessageTool(scheduled: Pick<ScheduledMessagesService, 'countPending'>, directory: ScheduleTargetDirectory) {
  return defineTool({
    declaration: {
      name: 'schedule_message',
      description:
        'Asks the person to confirm sending a message to one of their contacts later. recipient is the contact nickname, text is the exact message and sendAtLocal is local time without offset, like 2026-11-27T09:00. If the person did not say when, call without sendAtLocal (it returns need_time) and then ask them. Never make up a time. If it returns ambiguous, ask which of the options they mean.',
      parameters: {
        type: 'object',
        properties: {
          recipient: { type: 'string', description: 'Nickname of the contact.' },
          text: { type: 'string', description: 'The exact message to send.' },
          sendAtLocal: { type: 'string', description: 'Local date and time, like 2026-11-27T09:00.' },
        },
        required: ['recipient', 'text'],
      },
    },
    schema: z.object({ recipient: z.string(), text: z.string(), sendAtLocal: z.string().optional() }),
    run: async ({ recipient, text, sendAtLocal }, ctx) => {
      const clean = text.trim();
      if (clean.length === 0) {
        return { response: { error: 'empty' } };
      }
      if (Array.from(clean).length > SCHEDULED_TEXT_MAX_LENGTH) {
        return { response: { error: 'too_long' } };
      }
      const wanted = normalizeRecipient(recipient);
      const matches = wanted ? (await directory.listTargets(ctx.userId)).filter((target) => normalizeRecipient(target.nickname) === wanted) : [];
      const [target] = matches;
      if (!target) {
        return { response: { error: 'recipient_not_found' } };
      }
      if (matches.length > 1) {
        return { response: { error: 'ambiguous', options: matches.map((match) => match.nickname) } };
      }
      if (!sendAtLocal) {
        return { response: { error: 'need_time' } };
      }
      if (!parseLocalDateTime(sendAtLocal)) {
        return { response: { error: 'invalid_time' } };
      }
      const sendAt = localToUtc(sendAtLocal, ctx.timeZone);
      if (sendAt < ctx.now + SCHEDULED_MIN_LEAD_MS) {
        return { response: { error: 'too_soon' } };
      }
      if (sendAt > ctx.now + SCHEDULED_MAX_LEAD_MS) {
        return { response: { error: 'too_far' } };
      }
      if ((await scheduled.countPending(ctx.userId)) >= SCHEDULED_MAX_PENDING) {
        return { response: { error: 'limit' } };
      }
      const summary = SCHEDULED_TEXTS.confirmSummary(clean, target.nickname, formatWhen(sendAt, ctx.timeZone, ctx.locale), ctx.locale);
      return {
        response: { awaitingConfirmation: true, summary },
        card: confirmCard(
          { type: 'scheduled-message', roomId: target.roomId, recipient: target.nickname, text: clean, sendAtLocal, timeZone: ctx.timeZone, sendAt },
          ctx.locale,
        ),
      };
    },
  });
}

export function createListScheduledTool(scheduled: Pick<ScheduledMessagesService, 'listPending'>) {
  return defineTool({
    declaration: { name: 'list_scheduled', description: 'Shows the pending scheduled messages of the person with their ids.' },
    schema: z.object({}),
    run: async (_args, ctx) => {
      const pending = await scheduled.listPending(ctx.userId);
      const items = pending.map((item) => ({
        id: item.id,
        text: truncate(item.text, PREVIEW_LENGTH),
        detail: SCHEDULED_TEXTS.listDetail(item.recipient, formatWhen(item.sendAt, item.timeZone, ctx.locale), ctx.locale),
      }));
      return {
        response: { scheduled: items },
        card: { v: 1, kind: 'list', title: SCHEDULED_TEXTS.title[ctx.locale], items },
      };
    },
  });
}

export function createCancelScheduledTool(scheduled: Pick<ScheduledMessagesService, 'find'>) {
  return defineTool({
    declaration: {
      name: 'cancel_scheduled',
      description: 'Asks the person to confirm cancelling a scheduled message. Use only an id returned by list_scheduled.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    schema: z.object({ id: z.string() }),
    run: async ({ id }, ctx) => {
      const item = await scheduled.find(ctx.userId, id);
      if (!item) {
        return { response: { error: 'not_found' } };
      }
      const preview = truncate(SCHEDULED_TEXTS.cancelPreview(item.recipient, item.text), PREVIEW_LENGTH);
      return {
        response: { awaitingConfirmation: true, preview },
        card: confirmCard({ type: 'cancel-scheduled', scheduledId: item.id, preview }, ctx.locale),
      };
    },
  });
}
