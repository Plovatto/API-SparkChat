import { vi } from 'vitest';
import { RoomPresenceService } from '@/modules/messages/index.js';
import { ScheduledDelivery } from '@/modules/assistant/scheduled.delivery.js';
import { createScheduleTargetDirectory } from '@/modules/assistant/scheduled.directory.js';
import { registerScheduledConfirms, registerScheduledFailedReplies } from '@/modules/assistant/scheduled.quick-reply.js';
import { ScheduledRepository } from '@/modules/assistant/scheduled.repository.js';
import { ScheduledMessagesService, type ScheduleCardsPort } from '@/modules/assistant/scheduled.service.js';
import { createCancelScheduledTool, createListScheduledTool, createScheduleMessageTool } from '@/modules/assistant/tools/scheduled.tools.js';
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
import { registerStatusConfirm } from '@/modules/assistant/status.quick-reply.js';
import { createSetStatusTool } from '@/modules/assistant/tools/status.tool.js';
import { broadcastProfileUpdate } from '@/modules/users/user.socket.js';
import { createCancelReminderTool, createCreateReminderTool, createListRemindersTool } from '@/modules/assistant/tools/reminder.tools.js';
import type { AppServer } from '@/sockets/events.js';
import { establishFakeGeneration } from './room-keys.js';
import { TEST_V2_SIGNUP } from './test-constants.js';
import { TEST_PASSWORD } from './socket-harness.js';
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
  const statuses = {
    setTemporaryStatus: (userId: string, text: string, expiresAt: number) => context.userService.setTemporaryStatus(userId, text, expiresAt),
    expireStatuses: (at: number) => context.userService.expireStatuses(at),
    broadcastProfile: (ioServer: AppServer, userId: string) => broadcastProfileUpdate(ioServer, { userService: context.userService, roomService: context.roomService }, userId),
  };
  registerStatusConfirm(dispatcher, { ...statuses, now });
  registerReminderFiredReplies(registry, reminders, (userId) => context.userService.getTimeZone(userId));

  const toolbox = new AssistantToolbox()
    .register(createSaveNoteTool(notes))
    .register(createListNotesTool(notes))
    .register(createDeleteNoteTool(notes))
    .register(createCreateReminderTool())
    .register(createListRemindersTool(reminders))
    .register(createCancelReminderTool(reminders))
    .register(createSetStatusTool());

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

  return { ...context, registry, dispatcher, clock, now, host, notes, reminders, remindersRepository, toolbox, toolContext, statuses, io, emitted, tap, postCard };
}

export async function setupScheduling() {
  const tasks = await setupTasks();
  const { userService, roomService, roomKeyRepository, messageService, db, host, now, toolContext } = tasks;
  const bob = (await userService.registerAccount({ nickname: 'Bob', avatar: 0, password: TEST_PASSWORD, ...TEST_V2_SIGNUP })).user;
  const bobRoom = await roomService.createPrivateRoom(tasks.alice.id, bob.id);
  const bobKeyId = await establishFakeGeneration(roomKeyRepository, bobRoom.id, tasks.alice.id, bobRoom.participants);

  const scheduledRepository = new ScheduledRepository(db);
  const cards: ScheduleCardsPort = {
    openPendingConfirm: (userId, cardId) => tasks.aiService.openPendingConfirm(userId, cardId),
    claim: (cardId, userId) => tasks.aiService.claimCard(cardId, userId, 'yes'),
    announce: (ioServer, roomId, cardId, choice) => tasks.aiService.announceCardResolved(ioServer, roomId, cardId, choice),
  };
  const scheduled = new ScheduledMessagesService(scheduledRepository, host, cards, async (id) => (await messageService.getMessage(id)) !== null, now);
  registerScheduledConfirms(tasks.dispatcher, scheduled);
  registerScheduledFailedReplies(tasks.registry);
  const directory = createScheduleTargetDirectory(roomService, userService, tasks.assistant.id);
  tasks.toolbox
    .register(createScheduleMessageTool(scheduled, directory))
    .register(createListScheduledTool(scheduled))
    .register(createCancelScheduledTool(scheduled));
  const onMessageSent = vi.fn();
  const delivery = new ScheduledDelivery({ messageService, roomService, presenceService: new RoomPresenceService(), onMessageSent });

  return { ...tasks, bob, bobRoom, bobKeyId, scheduled, scheduledRepository, directory, delivery, onMessageSent, toolContext };
}
