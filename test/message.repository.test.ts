import { describe, expect, it } from 'vitest';
import { buildRoomService } from './support/build-room-service.js';

type Services = Awaited<ReturnType<typeof buildRoomService>>;

async function createUser(userService: Services['userService'], nickname: string) {
  const { user } = await userService.registerAccount({
    nickname,
    avatar: 0,
    password: 'correct-horse-battery-staple',
    socketId: `socket-${nickname}`,
  });
  return user;
}

async function seedRoom(services: Services, roomId: string, aliceId: string, bobId: string) {
  const { messageService, messageRepository } = services;

  const readByBob = await messageService.sendMessage({ roomId, senderId: aliceId, content: 'já lida', participantIds: [aliceId, bobId] });
  await messageRepository.update(readByBob.id, { readBy: [bobId], deliveredTo: [bobId], status: 'read' });

  await messageService.sendMessage({ roomId, senderId: bobId, content: 'do próprio bob' });
  await messageService.sendMessage({ roomId, senderId: aliceId, content: '@Bob olha isso', mentionedUserIds: [bobId] });

  const deleted = await messageService.sendMessage({ roomId, senderId: aliceId, content: 'apagada', mentionedUserIds: [bobId] });
  await messageRepository.update(deleted.id, { deletedForEveryone: true, content: '' });

  await messageService.sendMessage({ roomId, senderId: aliceId, content: 'não lida' });
}

describe('MessageRepository.findRoomDigests', () => {
  it('matches the in-memory unread, mention and last-message computation for each room', async () => {
    const services = await buildRoomService();
    const { messageService, messageRepository, userService } = services;
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    await seedRoom(services, 'room-a', alice.id, bob.id);
    await seedRoom(services, 'room-b', alice.id, bob.id);
    await messageService.sendMessage({ roomId: 'room-b', senderId: alice.id, content: 'última da sala b' });

    const digests = await messageRepository.findRoomDigests([{ roomId: 'room-a' }, { roomId: 'room-b' }, { roomId: 'empty' }], bob.id);

    for (const roomId of ['room-a', 'room-b']) {
      const all = await messageService.getRoomMessages(roomId);
      const digest = digests.get(roomId);
      expect(digest?.unreadCount).toBe(messageService.countUnread(all, bob.id));
      expect(digest?.mentionCount).toBe(messageService.countUnreadMentions(all, bob.id));
      expect(digest?.lastMessage?.id).toBe(all[all.length - 1]?.id);
    }

    expect(digests.get('room-a')?.unreadCount).toBe(2);
    expect(digests.get('room-a')?.mentionCount).toBe(1);
    expect(digests.get('room-b')?.lastMessage?.content).toBe('última da sala b');
    expect(digests.get('empty')).toEqual({ lastMessage: null, unreadCount: 0, mentionCount: 0 });
  });

  it('respects the visibility cutoff when computing digests', async () => {
    const services = await buildRoomService();
    const { messageService, messageRepository, userService } = services;
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const before = await messageService.sendMessage({ roomId: 'room-a', senderId: alice.id, content: 'antes', mentionedUserIds: [bob.id] });
    await messageService.sendMessage({ roomId: 'room-a', senderId: alice.id, content: 'depois' });

    const digests = await messageRepository.findRoomDigests([{ roomId: 'room-a', after: before.timestamp }], bob.id);
    const digest = digests.get('room-a');

    expect(digest?.lastMessage?.content).toBe('depois');
    expect(digest?.unreadCount).toBe(1);
    expect(digest?.mentionCount).toBe(0);
  });
});

describe('MessageRepository.countUnread', () => {
  it('returns the same counts as the in-memory helpers over the whole room', async () => {
    const services = await buildRoomService();
    const { messageService, messageRepository, userService } = services;
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    await seedRoom(services, 'room-a', alice.id, bob.id);

    const all = await messageService.getRoomMessages('room-a');
    const counts = await messageRepository.countUnread('room-a', bob.id);

    expect(counts).toEqual({
      unreadCount: messageService.countUnread(all, bob.id),
      mentionCount: messageService.countUnreadMentions(all, bob.id),
    });
    expect(await messageRepository.countUnread('room-a', alice.id)).toEqual({
      unreadCount: messageService.countUnread(all, alice.id),
      mentionCount: messageService.countUnreadMentions(all, alice.id),
    });
    expect(await messageRepository.countUnread('room-a', alice.id)).toEqual({ unreadCount: 1, mentionCount: 0 });
  });
});

describe('MessageRepository.findUnreadByRoomId', () => {
  it('returns only messages from others that the user has not read yet, oldest first', async () => {
    const services = await buildRoomService();
    const { messageRepository, userService } = services;
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    await seedRoom(services, 'room-a', alice.id, bob.id);

    const unread = await messageRepository.findUnreadByRoomId('room-a', bob.id);

    expect(unread.map((message) => message.content)).toEqual(['@Bob olha isso', '', 'não lida']);
    expect(unread.every((message) => message.senderId === alice.id && !message.readBy.includes(bob.id))).toBe(true);
  });
});

describe('MessageRepository.findUndeliveredInRooms', () => {
  it('returns pending messages across rooms, skipping delivered, read, own and deleted ones', async () => {
    const services = await buildRoomService();
    const { messageService, messageRepository, userService } = services;
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    await userService.setStatus(bob.id, 'offline');

    await seedRoom(services, 'room-a', alice.id, bob.id);
    await messageService.sendMessage({ roomId: 'room-b', senderId: alice.id, content: 'pendente na b', participantIds: [alice.id, bob.id] });
    await messageService.sendMessage({ roomId: 'room-c', senderId: alice.id, content: 'sala não pedida' });

    const pending = await messageRepository.findUndeliveredInRooms(['room-a', 'room-b'], bob.id);
    const byRoom = (roomId: string) => pending.filter((message) => message.roomId === roomId).map((message) => message.content);

    expect(pending).toHaveLength(3);
    expect(byRoom('room-a')).toEqual(['@Bob olha isso', 'não lida']);
    expect(byRoom('room-b')).toEqual(['pendente na b']);
    expect(await messageRepository.findUndeliveredInRooms([], bob.id)).toEqual([]);
  });
});

describe('MessageService.markPendingMessagesDeliveredInRooms', () => {
  it('delivers pending messages grouped by room in a single pass', async () => {
    const services = await buildRoomService();
    const { messageService, userService } = services;
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    await userService.setStatus(bob.id, 'offline');

    await messageService.sendMessage({ roomId: 'room-a', senderId: alice.id, content: 'a1', participantIds: [alice.id, bob.id] });
    await messageService.sendMessage({ roomId: 'room-b', senderId: alice.id, content: 'b1', participantIds: [alice.id, bob.id] });
    await messageService.sendMessage({ roomId: 'room-b', senderId: alice.id, content: 'b2', participantIds: [alice.id, bob.id] });

    await userService.setStatus(bob.id, 'online');
    const deliveredByRoom = await messageService.markPendingMessagesDeliveredInRooms(['room-a', 'room-b'], bob.id);

    expect(deliveredByRoom.get('room-a')?.map((message) => message.content)).toEqual(['a1']);
    expect(deliveredByRoom.get('room-b')?.map((message) => message.content)).toEqual(['b1', 'b2']);
    expect(deliveredByRoom.get('room-b')?.every((message) => message.deliveredTo.includes(bob.id) && message.status === 'delivered')).toBe(true);

    const second = await messageService.markPendingMessagesDeliveredInRooms(['room-a', 'room-b'], bob.id);
    expect(second.size).toBe(0);
  });
});

describe('MessageService.toViews', () => {
  it('resolves every sender, including ones not yet cached, in a single batch', async () => {
    const services = await buildRoomService();
    const { messageService, userService } = services;
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const first = await messageService.sendMessage({ roomId: 'room-a', senderId: alice.id, content: 'oi' });
    const second = await messageService.sendMessage({ roomId: 'room-a', senderId: bob.id, content: 'olá' });
    const system = await messageService.createSystemMessage('room-a', 'Bob entrou no grupo');

    const views = await messageService.toViews([first, second, system]);

    expect(views.map((view) => view.sender)).toEqual([
      { id: alice.id, nickname: 'Alice', avatar: 0 },
      { id: bob.id, nickname: 'Bob', avatar: 0 },
      { id: 'system', nickname: 'Sistema', avatar: null },
    ]);
  });
});
