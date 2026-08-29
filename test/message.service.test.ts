import { describe, expect, it } from 'vitest';
import { buildRoomService } from './support/build-room-service.js';

async function createUser(userService: ReturnType<typeof buildRoomService>['userService'], nickname: string) {
  return userService.joinOrCreate({ nickname, avatar: 0, socketId: `socket-${nickname}` });
}

describe('MessageService', () => {
  it('sends a text message and enriches it with sender info', async () => {
    const { messageService, userService } = buildRoomService();
    const alice = await createUser(userService, 'Alice');

    const message = await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'Oi!' });
    const view = await messageService.toView(message);

    expect(view.sender).toEqual({ id: alice.id, nickname: 'Alice', avatar: 0 });
    expect(view.content).toBe('Oi!');
    expect(view.type).toBe('text');
    expect(view.status).toBe('sent');
  });

  it('creates a system message attributed to "Sistema"', async () => {
    const { messageService } = buildRoomService();

    const message = await messageService.createSystemMessage('room-1', 'Alice criou o grupo');
    const view = await messageService.toView(message);

    expect(view.sender).toEqual({ id: 'system', nickname: 'Sistema', avatar: null });
    expect(view.type).toBe('system');
  });

  it('marks unread messages as read for a user and reports the correct unread count', async () => {
    const { messageService, userService } = buildRoomService();
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

  it('hides the content of a deleted-for-everyone message in its view', async () => {
    const { messageService, messageRepository, userService } = buildRoomService();
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
    const { messageService, userService } = buildRoomService();
    const alice = await createUser(userService, 'Alice');

    const message = await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'apagar isso' });
    const deleted = await messageService.deleteMessage(message.id, alice.id);

    expect(deleted.deletedForEveryone).toBe(true);
    expect(deleted.content).toBe('');
  });

  it('rejects deleting a message that belongs to someone else', async () => {
    const { messageService, userService } = buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const message = await messageService.sendMessage({ roomId: 'room-1', senderId: alice.id, content: 'não apague' });

    await expect(messageService.deleteMessage(message.id, bob.id)).rejects.toThrow(
      'Você não tem permissão para deletar esta mensagem.',
    );
  });

  it('rejects deleting a message that does not exist', async () => {
    const { messageService, userService } = buildRoomService();
    const alice = await createUser(userService, 'Alice');

    await expect(messageService.deleteMessage('unknown-id', alice.id)).rejects.toThrow('Mensagem não encontrada.');
  });
});

describe('RoomService + MessageService integration', () => {
  it('reflects a sent message as the room lastMessage and increases unreadCount for the recipient', async () => {
    const { roomService, messageService, userService } = buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const room = await roomService.createPrivateRoom(alice.id, bob.id);
    await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content: 'Oi Bob!' });

    const summaryForBob = await roomService.buildSummary(room, bob.id);

    expect(summaryForBob.lastMessage?.content).toBe('Oi Bob!');
    expect(summaryForBob.unreadCount).toBe(1);
  });

  it('makes a freshly created private room visible to the recipient once a message is sent', async () => {
    const { roomService, messageService, userService } = buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const room = await roomService.createPrivateRoom(alice.id, bob.id);
    expect(await roomService.getVisibleRoomsForUser(bob.id)).toHaveLength(0);

    await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content: 'Oi Bob!' });
    await roomService.makeVisibleForAll(room);

    const bobRooms = await roomService.getVisibleRoomsForUser(bob.id);
    expect(bobRooms.map((r) => r.id)).toEqual([room.id]);
  });

  it('rejects a message from a user blocked in the room', async () => {
    const { roomService, userService } = buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const room = await roomService.createPrivateRoom(alice.id, bob.id);
    await roomService.blockUser(room.id, alice.id, bob.id);
    const blockedRoom = await roomService.getRoomById(room.id);

    expect(blockedRoom && roomService.isBlocked(blockedRoom, bob.id)).toBe(true);
    expect(blockedRoom && roomService.isBlocked(blockedRoom, alice.id)).toBe(true);
  });
});
