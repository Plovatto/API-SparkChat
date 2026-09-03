import { describe, expect, it } from 'vitest';
import { buildRoomService } from './support/build-room-service.js';

async function createUser(userService: Awaited<ReturnType<typeof buildRoomService>>['userService'], nickname: string) {
  const { user } = await userService.registerAccount({
    nickname,
    avatar: 0,
    password: 'correct-horse-battery-staple',
    socketId: `socket-${nickname}`,
  });
  return user;
}

describe('MessageService', () => {
  it('sends a text message and enriches it with sender info', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');

    const message = await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'Oi!' });
    const view = await messageService.toView(message);

    expect(view.sender).toEqual({ id: alice.id, nickname: 'Alice', avatar: 0 });
    expect(view.content).toBe('Oi!');
    expect(view.type).toBe('text');
    expect(view.status).toBe('sent');
  });

  it('creates a system message attributed to "Sistema"', async () => {
    const { messageService } = await buildRoomService();

    const message = await messageService.createSystemMessage('room-1', 'Alice criou o grupo');
    const view = await messageService.toView(message);

    expect(view.sender).toEqual({ id: 'system', nickname: 'Sistema', avatar: null });
    expect(view.type).toBe('system');
  });

  it('marks unread messages as read for a user and reports the correct unread count', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'Oi Bob' });
    await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'Tudo bem?' });

    const beforeRead = await messageService.getRoomMessages('room-1');
    expect(messageService.countUnread(beforeRead, bob.id)).toBe(2);
    expect(messageService.countUnread(beforeRead, alice.id)).toBe(0);

    const afterRead = await messageService.markRoomAsRead('room-1', bob.id);
    expect(messageService.countUnread(afterRead, bob.id)).toBe(0);
  });

  it('counts only unread messages that mention the given user', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: '@Bob confere isso', mentionedUserIds: [bob.id] });
    await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: '@Bob de novo', mentionedUserIds: [bob.id] });
    await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'mensagem sem menção' });

    const messages = await messageService.getRoomMessages('room-1');
    expect(messageService.countUnreadMentions(messages, bob.id)).toBe(2);
    expect(messageService.countUnreadMentions(messages, alice.id)).toBe(0);

    const afterRead = await messageService.markRoomAsRead('room-1', bob.id);
    expect(messageService.countUnreadMentions(afterRead, bob.id)).toBe(0);
  });

  it('hides the content of a deleted-for-everyone message in its view', async () => {
    const { messageService, messageRepository, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');

    const message = await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'apagar isso' });
    await messageRepository.update(message.id, { deletedForEveryone: true });
    const deleted = await messageRepository.findById(message.id);
    if (!deleted) {
      throw new Error('message not found');
    }

    const view = await messageService.toView(deleted);
    expect(view.content).toBe('');
    expect(view.deletedForEveryone).toBe(true);
  });

  it('lets the sender delete their own message, clearing content and flagging it', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');

    const message = await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'apagar isso' });
    const deleted = await messageService.deleteMessage(message.id, alice.id);

    expect(deleted.deletedForEveryone).toBe(true);
    expect(deleted.content).toBe('');
  });

  it('rejects deleting a message that belongs to someone else', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const message = await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'não apague' });

    await expect(messageService.deleteMessage(message.id, bob.id)).rejects.toThrow(
      'Você não tem permissão para deletar esta mensagem.',
    );
  });

  it('rejects deleting a message that does not exist', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');

    await expect(messageService.deleteMessage('unknown-id', alice.id)).rejects.toThrow('Mensagem não encontrada.');
  });

  it('attaches a resolved snapshot of the original message when replying', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const original = await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'Oi Bob!' });
    const reply = await messageService.sendMessage({
      roomId: 'room-1',
      senderId: bob.id,
      content: 'Oi Alice!',
      replyToMessageId: original.id,
    });

    expect(reply.replyTo).toEqual({
      id: original.id,
      content: 'Oi Bob!',
      type: 'text',
      duration: null,
      sender: { id: alice.id, nickname: 'Alice', avatar: 0 },
    });
  });

  it('leaves replyTo null when replying to a message id that does not exist', async () => {
    const { messageService, userService } = await buildRoomService();
    const bob = await createUser(userService, 'Bob');

    const message = await messageService.sendMessage({
      roomId: 'room-1',
      senderId: bob.id,
      content: 'Oi?',
      replyToMessageId: 'unknown-id',
    });

    expect(message.replyTo).toBeNull();
  });
});

describe('MessageService.markAudioPlayed', () => {
  it('adds the listener to playedBy on first play', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const message = await messageService.sendMessage({
      roomId: 'room-1',
      senderId: alice.id,
      content: '/uploads/audio/clip.webm',
      type: 'audio',
      duration: 5,
    });

    const updated = await messageService.markAudioPlayed(message.id, bob.id);

    expect(updated?.playedBy).toEqual([bob.id]);
  });

  it('is a no-op when the sender tries to mark their own audio as played', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');

    const message = await messageService.sendMessage({
      roomId: 'room-1',
      senderId: alice.id,
      content: '/uploads/audio/clip.webm',
      type: 'audio',
      duration: 5,
    });

    const updated = await messageService.markAudioPlayed(message.id, alice.id);

    expect(updated).toBeNull();
  });

  it('is a no-op when the same listener plays it again', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const message = await messageService.sendMessage({
      roomId: 'room-1',
      senderId: alice.id,
      content: '/uploads/audio/clip.webm',
      type: 'audio',
      duration: 5,
    });

    await messageService.markAudioPlayed(message.id, bob.id);
    const secondAttempt = await messageService.markAudioPlayed(message.id, bob.id);

    expect(secondAttempt).toBeNull();
  });

  it('is a no-op for non-audio messages', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const message = await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'Oi!' });

    const updated = await messageService.markAudioPlayed(message.id, bob.id);

    expect(updated).toBeNull();
  });
});

describe('MessageService delivery tracking', () => {
  it('marks a message delivered immediately when the recipient is already online', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const message = await messageService.sendMessage({
      roomId: 'room-1',
      senderId: alice.id,
      content: 'Oi Bob',
      participantIds: [alice.id, bob.id],
    });

    expect(message.deliveredTo).toEqual([bob.id]);
    expect(message.status).toBe('delivered');
  });

  it('marks a message read immediately when the recipient is currently viewing the room', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const message = await messageService.sendMessage({
      roomId: 'room-1',
      senderId: alice.id,
      content: 'Oi Bob',
      participantIds: [alice.id, bob.id],
      viewingUserIds: [bob.id],
    });

    expect(message.deliveredTo).toEqual([bob.id]);
    expect(message.readBy).toEqual([bob.id]);
    expect(message.status).toBe('read');
  });

  it('ignores viewers who are not delivered recipients when marking a message read', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    await userService.setStatus(bob.id, 'offline');

    const message = await messageService.sendMessage({
      roomId: 'room-1',
      senderId: alice.id,
      content: 'Oi Bob',
      participantIds: [alice.id, bob.id],
      viewingUserIds: [bob.id, alice.id],
    });

    expect(message.deliveredTo).toEqual([]);
    expect(message.readBy).toEqual([]);
    expect(message.status).toBe('sent');
  });

  it('leaves a message as sent when the recipient is offline', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    await userService.setStatus(bob.id, 'offline');

    const message = await messageService.sendMessage({
      roomId: 'room-1',
      senderId: alice.id,
      content: 'Oi Bob',
      participantIds: [alice.id, bob.id],
    });

    expect(message.deliveredTo).toEqual([]);
    expect(message.status).toBe('sent');
  });

  it('retroactively delivers pending messages once the recipient reconnects', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    await userService.setStatus(bob.id, 'offline');

    const message = await messageService.sendMessage({
      roomId: 'room-1',
      senderId: alice.id,
      content: 'Oi Bob',
      participantIds: [alice.id, bob.id],
    });
    expect(message.status).toBe('sent');

    await userService.setStatus(bob.id, 'online');
    const delivered = await messageService.markPendingMessagesDelivered('room-1', bob.id);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.deliveredTo).toEqual([bob.id]);
    expect(delivered[0]?.status).toBe('delivered');
  });

  it('does not redeliver messages the recipient already read or that they themselves sent', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'lida' });
    await messageService.sendMessage({ roomId: 'room-1', senderId: bob.id, content: 'do proprio Bob' });
    await messageService.markRoomAsRead('room-1', bob.id);

    const delivered = await messageService.markPendingMessagesDelivered('room-1', bob.id);

    expect(delivered).toHaveLength(0);
  });

  it('adds the reader to deliveredTo when marking a message as read', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'Oi Bob' });
    const [message] = await messageService.markRoomAsRead('room-1', bob.id);

    expect(message?.deliveredTo).toEqual([bob.id]);
    expect(message?.readBy).toEqual([bob.id]);
    expect(message?.status).toBe('read');
  });

  it('marks only the provided message ids as read when opening a paged conversation', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const older = await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'antiga' });
    const latest = await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'recente' });

    const marked = await messageService.markRoomAsRead('room-1', bob.id, [latest.id]);
    const allMessages = await messageService.getRoomMessages('room-1');

    expect(marked.map((message) => message.id)).toEqual([latest.id]);
    expect(allMessages.find((message) => message.id === latest.id)?.readBy).toEqual([bob.id]);
    expect(allMessages.find((message) => message.id === older.id)?.readBy).toEqual([]);
  });
});

describe('MessageService.getRoomMessagesPage', () => {
  it('returns the most recent messages in ascending order and flags that older ones remain', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');

    for (let i = 0; i < 5; i += 1) {
      await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: `msg ${i}` });
    }

    const { messages: page, hasMore } = await messageService.getRoomMessagesPage('room-1', { limit: 3 });

    expect(page.map((message) => message.content)).toEqual(['msg 2', 'msg 3', 'msg 4']);
    expect(hasMore).toBe(true);
  });

  it('reports hasMore as false once the full history fits within the limit', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');

    await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'oi' });
    await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'tudo bem?' });

    const { messages: page, hasMore } = await messageService.getRoomMessagesPage('room-1', { limit: 10 });

    expect(page).toHaveLength(2);
    expect(hasMore).toBe(false);
  });

  it('paginates backwards with "before", excluding the boundary message', async () => {
    const { messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');

    for (let i = 0; i < 5; i += 1) {
      await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: `msg ${i}` });
    }

    const firstPage = await messageService.getRoomMessagesPage('room-1', { limit: 3 });
    expect(firstPage.messages.map((message) => message.content)).toEqual(['msg 2', 'msg 3', 'msg 4']);

    const oldestLoaded = firstPage.messages[0];
    if (!oldestLoaded) {
      throw new Error('expected a loaded message');
    }

    const olderPage = await messageService.getRoomMessagesPage('room-1', { before: oldestLoaded.timestamp, limit: 3 });

    expect(olderPage.messages.map((message) => message.content)).toEqual(['msg 0', 'msg 1']);
    expect(olderPage.hasMore).toBe(false);
  });

  it('excludes messages before the visibility cutoff even when they would otherwise fit the page', async () => {
    const { roomService, messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const room = await roomService.createPrivateRoom(alice.id, bob.id);
    await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content: 'antes de sair' });
    await roomService.deleteForUser(room.id, bob.id);
    await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content: 'depois de voltar' });

    const roomAfterDelete = await roomService.getRoomById(room.id);
    if (!roomAfterDelete) {
      throw new Error('expected room to exist');
    }

    const cutoff = roomService.getVisibilityCutoff(roomAfterDelete, bob.id);
    const { messages: page } = await messageService.getRoomMessagesPage(room.id, { after: cutoff, limit: 10 });

    expect(page.map((message) => message.content)).toEqual(['depois de voltar']);
  });
});

describe('RoomService + MessageService integration', () => {
  it('reflects a sent message as the room lastMessage and increases unreadCount for the recipient', async () => {
    const { roomService, messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const room = await roomService.createPrivateRoom(alice.id, bob.id);
    await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content: 'Oi Bob!' });

    const summaryForBob = await roomService.buildSummary(room, bob.id);

    expect(summaryForBob.lastMessage?.content).toBe('Oi Bob!');
    expect(summaryForBob.unreadCount).toBe(1);
  });

  it('makes a freshly created private room visible to the recipient once a message is sent', async () => {
    const { roomService, messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const room = await roomService.createPrivateRoom(alice.id, bob.id);
    expect(await roomService.getVisibleRoomsForUser(bob.id)).toHaveLength(0);

    await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content: 'Oi Bob!' });
    await roomService.makeVisibleForAll(room, new Date().toISOString());

    const bobRooms = await roomService.getVisibleRoomsForUser(bob.id);
    expect(bobRooms.map((r) => r.id)).toEqual([room.id]);
  });

  it('rejects a message from a user blocked in the room', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const room = await roomService.createPrivateRoom(alice.id, bob.id);
    await roomService.blockUser(room.id, alice.id, bob.id);
    const blockedRoom = await roomService.getRoomById(room.id);

    expect(blockedRoom && roomService.isBlocked(blockedRoom, bob.id)).toBe(true);
    expect(blockedRoom && roomService.isBlocked(blockedRoom, alice.id)).toBe(true);
  });
});
