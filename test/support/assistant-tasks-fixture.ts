import { ConfirmDispatcher } from '@/modules/assistant/assistant.confirm.js';
import type { AssistantHost } from '@/modules/assistant/assistant.host.js';
import { QuickReplyRegistry } from '@/modules/assistant/assistant.quick-reply.js';
import { AssistantToolbox, type AssistantContext } from '@/modules/assistant/assistant.toolbox.js';
import type { AssistantCard } from '@/modules/assistant/assistant.card.js';
import { NotesRepository } from '@/modules/assistant/notes.repository.js';
import { NotesService } from '@/modules/assistant/notes.service.js';
import { registerNoteConfirms, registerReminderConfirms, registerReminderFiredReplies } from '@/modules/assistant/reminder.quick-reply.js';
import { RemindersRepository } from '@/modules/assistant/reminders.repository.js';
import { RemindersService } from '@/modules/assistant/reminders.service.js';
import { createDeleteNoteTool, createListNotesTool, createSaveNoteTool } from '@/modules/assistant/tools/note.tools.js';
import { createCancelReminderTool, createCreateReminderTool, createListRemindersTool } from '@/modules/assistant/tools/reminder.tools.js';
import { createFakeServer, setupAssistantRoom, type EmittedEvent } from './ai-fixture.js';

export const TIME_ZONE = 'America/Sao_Paulo';
export const T0 = Date.UTC(2026, 10, 26, 12, 0);

export async function setupTasks() {
  const clock = { now: T0 };
  const now = (): number => clock.now;
  const registry = new QuickReplyRegistry();
  const context = await setupAssistantRoom({ quickReplies: registry });
  const host: AssistantHost = context.aiService;

  const notes = new NotesService(new NotesRepository(context.db), host, now);
  const remindersRepository = new RemindersRepository(context.db);
  const reminders = new RemindersService(remindersRepository, host, now);
  const dispatcher = new ConfirmDispatcher().attachTo(registry);
  registerNoteConfirms(dispatcher, notes);
  registerReminderConfirms(dispatcher, reminders, now);
  registerReminderFiredReplies(registry, reminders, (userId) => context.userService.getTimeZone(userId));

  const toolbox = new AssistantToolbox()
    .register(createSaveNoteTool(notes))
    .register(createListNotesTool(notes))
    .register(createDeleteNoteTool(notes))
    .register(createCreateReminderTool())
    .register(createListRemindersTool(reminders))
    .register(createCancelReminderTool(reminders));

  const emitted: EmittedEvent[] = [];
  const io = createFakeServer(emitted);
  const toolContext = (locale: 'pt' | 'en' = 'pt'): AssistantContext => ({
    io,
    userId: context.alice.id,
    roomId: context.room.id,
    locale,
    timeZone: TIME_ZONE,
    now: clock.now,
  });

  async function tap(cardId: string, choice: Parameters<typeof context.sendQuickReplyFromAlice>[0]['choice']) {
    const message = await context.sendQuickReplyFromAlice({ cardId, choice });
    await context.aiService.handleIncomingMessage(io, context.room, message, 'pt');
  }

  async function postCard(card: AssistantCard) {
    return context.sendCardFromAssistant(card);
  }

  return { ...context, clock, now, host, notes, reminders, remindersRepository, toolbox, toolContext, io, emitted, tap, postCard };
}
