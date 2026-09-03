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

describe('RoomService', () => {
  it('creates a private room between two users', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const room = await roomService.createPrivateRoom(alice.id, bob.id);

    expect(room.type).toBe('private');
    expect(room.participants).toEqual([alice.id, bob.id]);
    expect(room.visibleTo).toEqual([alice.id]);
  });

  it('reuses the existing private room instead of duplicating it', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const first = await roomService.createPrivateRoom(alice.id, bob.id);
    const second = await roomService.createPrivateRoom(alice.id, bob.id);

    expect(second.id).toBe(first.id);
  });

  it('creates a group room with a generated room code and the creator as participant and admin', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');

    const room = await roomService.createGroupRoom('Amigos', alice.id);

    expect(room.type).toBe('group');
    expect(room.name).toBe('Amigos');
    expect(room.roomCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(room.participants).toEqual([alice.id]);
    expect(room.admins).toEqual([alice.id]);
    expect(room.createdBy).toBe(alice.id);
  });

  it('only lists rooms visible to the given user', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const carol = await createUser(userService, 'Carol');

    const aliceBobRoom = await roomService.createPrivateRoom(alice.id, bob.id);
    const bobCarolRoom = await roomService.createPrivateRoom(bob.id, carol.id);

    const aliceRooms = await roomService.getVisibleRoomsForUser(alice.id);
    const bobRooms = await roomService.getVisibleRoomsForUser(bob.id);

    expect(aliceRooms.map((room) => room.id)).toEqual([aliceBobRoom.id]);
    expect(bobRooms.map((room) => room.id)).toEqual([bobCarolRoom.id]);
  });

  it('builds a room summary with resolved participant info and blocking status', async () => {
    const { roomService, roomRepository, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const room = await roomService.createPrivateRoom(alice.id, bob.id);
    await roomRepository.update(room.id, { blockedBy: { [bob.id]: alice.id } });
    const blockedRoom = await roomRepository.findById(room.id);
    if (!blockedRoom) {
      throw new Error('room not found');
    }

    const summaryForAlice = await roomService.buildSummary(blockedRoom, alice.id);
    const summaryForBob = await roomService.buildSummary(blockedRoom, bob.id);

    expect(summaryForAlice.participants.map((p) => p.nickname).sort()).toEqual(['Alice', 'Bob']);
    expect(summaryForAlice.userBlocked).toBe(true);
    expect(summaryForAlice.isBlockedBy).toBe(false);
    expect(summaryForBob.isBlockedBy).toBe(true);
    expect(summaryForBob.userBlocked).toBe(false);
  });

  it('exposes mentionCount for a group room, counting only messages that mention the viewer', async () => {
    const { roomService, messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const group = await roomService.createGroupRoom('Amigos', alice.id);
    await roomService.joinByCode(group.roomCode ?? '', bob.id);

    await messageService.sendMessage({ roomId: group.id, senderId: alice.id, content: '@Bob confere isso', mentionedUserIds: [bob.id] });
    await messageService.sendMessage({ roomId: group.id, senderId: alice.id, content: 'sem menção' });

    const summaryForBob = await roomService.buildSummary(group, bob.id);
    const summaryForAlice = await roomService.buildSummary(group, alice.id);

    expect(summaryForBob.mentionCount).toBe(1);
    expect(summaryForBob.unreadCount).toBe(2);
    expect(summaryForAlice.mentionCount).toBe(0);
  });

  it('joins a group by its room code and notifies only on the first join', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const group = await roomService.createGroupRoom('Amigos', alice.id);

    const firstJoin = await roomService.joinByCode(group.roomCode ?? '', bob.id);
    const secondJoin = await roomService.joinByCode(group.roomCode ?? '', bob.id);

    expect(firstJoin.joined).toBe(true);
    expect(firstJoin.room.participants).toContain(bob.id);
    expect(secondJoin.joined).toBe(false);
  });

  it('throws when joining by an unknown room code', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');

    await expect(roomService.joinByCode('NOPE0000', alice.id)).rejects.toThrow('Sala não encontrada.');
  });

  it('removes a user from a room visibility without affecting other participants', async () => {
    const { roomService, roomRepository, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const room = await roomService.createPrivateRoom(alice.id, bob.id);

    await roomService.deleteForUser(room.id, alice.id);
    const updated = await roomRepository.findById(room.id);

    expect(updated?.visibleTo).not.toContain(alice.id);
    expect(updated?.participants).toEqual([alice.id, bob.id]);
  });

  it('removes a user from a group entirely on leave', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const group = await roomService.createGroupRoom('Amigos', alice.id);
    await roomService.joinByCode(group.roomCode ?? '', bob.id);

    const updated = await roomService.leaveGroup(group.id, bob.id);

    expect(updated?.participants).toEqual([alice.id]);
    expect(updated?.visibleTo).toEqual([alice.id]);
  });

  it('removes the leaving user from the admin list too', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const group = await roomService.createGroupRoom('Amigos', alice.id);
    await roomService.joinByCode(group.roomCode ?? '', bob.id);
    await roomService.promoteAdmin(group.id, alice.id, bob.id);

    const updated = await roomService.leaveGroup(group.id, bob.id);

    expect(updated?.admins).toEqual([alice.id]);
  });

  it('lets an admin promote another participant to admin', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const group = await roomService.createGroupRoom('Amigos', alice.id);
    await roomService.joinByCode(group.roomCode ?? '', bob.id);

    const updated = await roomService.promoteAdmin(group.id, alice.id, bob.id);

    expect(updated?.admins.sort()).toEqual([alice.id, bob.id].sort());
  });

  it('rejects promoting an admin when the acting user is not one', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const carol = await createUser(userService, 'Carol');
    const group = await roomService.createGroupRoom('Amigos', alice.id);
    await roomService.joinByCode(group.roomCode ?? '', bob.id);
    await roomService.joinByCode(group.roomCode ?? '', carol.id);

    await expect(roomService.promoteAdmin(group.id, bob.id, carol.id)).rejects.toThrow(
      'Apenas administradores podem promover outros membros.',
    );
  });

  it('rejects promoting someone who is not a participant', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const outsider = await createUser(userService, 'Outsider');
    const group = await roomService.createGroupRoom('Amigos', alice.id);

    await expect(roomService.promoteAdmin(group.id, alice.id, outsider.id)).rejects.toThrow(
      'Usuário não faz parte do grupo.',
    );
  });

  it('lets an admin remove a member from the group', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const group = await roomService.createGroupRoom('Amigos', alice.id);
    await roomService.joinByCode(group.roomCode ?? '', bob.id);

    const updated = await roomService.removeMember(group.id, alice.id, bob.id);

    expect(updated?.participants).toEqual([alice.id]);
    expect(updated?.visibleTo).toEqual([alice.id]);
    expect(updated?.admins).toEqual([alice.id]);
  });

  it('rejects removing a member when the acting user is not an admin', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const carol = await createUser(userService, 'Carol');
    const group = await roomService.createGroupRoom('Amigos', alice.id);
    await roomService.joinByCode(group.roomCode ?? '', bob.id);
    await roomService.joinByCode(group.roomCode ?? '', carol.id);

    await expect(roomService.removeMember(group.id, bob.id, carol.id)).rejects.toThrow(
      'Apenas administradores podem remover membros.',
    );
  });

  it('rejects an admin trying to remove themselves', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const group = await roomService.createGroupRoom('Amigos', alice.id);

    await expect(roomService.removeMember(group.id, alice.id, alice.id)).rejects.toThrow(
      'Use a opção de sair do grupo para se remover.',
    );
  });

  it('exposes isAdmin per participant in the room summary', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const group = await roomService.createGroupRoom('Amigos', alice.id);
    const { room: groupWithBob } = await roomService.joinByCode(group.roomCode ?? '', bob.id);

    const summary = await roomService.buildSummary(groupWithBob, alice.id);

    expect(summary.participants.find((p) => p.id === alice.id)?.isAdmin).toBe(true);
    expect(summary.participants.find((p) => p.id === bob.id)?.isAdmin).toBe(false);
  });

  it('blocks and unblocks a user within a room', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const room = await roomService.createPrivateRoom(alice.id, bob.id);

    const blocked = await roomService.blockUser(room.id, alice.id, bob.id);
    expect(blocked?.blockedBy[bob.id]).toBe(alice.id);

    const unblocked = await roomService.unblockUser(room.id, alice.id, bob.id);
    expect(unblocked?.blockedBy[bob.id]).toBeUndefined();
  });

  it('rejects blocking when the acting user is not a room participant', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const outsider = await createUser(userService, 'Outsider');
    const room = await roomService.createPrivateRoom(alice.id, bob.id);

    const result = await roomService.blockUser(room.id, outsider.id, bob.id);
    expect(result).toBeNull();
  });

  it('rejects unblocking when the acting user is not the one who blocked', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const room = await roomService.createPrivateRoom(alice.id, bob.id);

    await roomService.blockUser(room.id, alice.id, bob.id);
    const result = await roomService.unblockUser(room.id, bob.id, bob.id);

    expect(result).toBeNull();
  });

  it('ignores leaveGroup and deleteForUser for a user who is not a participant', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const outsider = await createUser(userService, 'Outsider');
    const room = await roomService.createPrivateRoom(alice.id, bob.id);
    const group = await roomService.createGroupRoom('Amigos', alice.id);

    expect(await roomService.deleteForUser(room.id, outsider.id)).toBeNull();
    expect(await roomService.leaveGroup(group.id, outsider.id)).toBeNull();
  });

  it('only treats actual room participants as participants', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const carol = await createUser(userService, 'Carol');
    const room = await roomService.createPrivateRoom(alice.id, bob.id);

    expect(roomService.isParticipant(room, alice.id)).toBe(true);
    expect(roomService.isParticipant(room, bob.id)).toBe(true);
    expect(roomService.isParticipant(room, carol.id)).toBe(false);
  });

  it('reports the recipient as newly visible right after creating a private room, and no one once visible to all', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const room = await roomService.createPrivateRoom(alice.id, bob.id);

    expect(roomService.getNewlyVisibleParticipants(room, alice.id)).toEqual([bob.id]);

    const updated = await roomService.makeVisibleForAll(room, new Date().toISOString());
    expect(updated && roomService.getNewlyVisibleParticipants(updated, alice.id)).toEqual([]);
  });

  it('stamps reactivatedAt with the given cutoff for participants newly made visible', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const room = await roomService.createPrivateRoom(alice.id, bob.id);

    const cutoff = '2026-01-01T00:00:00.000Z';
    const updated = await roomService.makeVisibleForAll(room, cutoff);

    expect(updated?.reactivatedAt?.[bob.id]).toBe(cutoff);
  });

  it('does not reset reactivatedAt when reopening a private room still visible to the user', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const first = await roomService.createPrivateRoom(alice.id, bob.id);
    const madeVisible = await roomService.makeVisibleForAll(first, '2026-01-01T00:00:00.000Z');

    const reopened = await roomService.createPrivateRoom(bob.id, alice.id);

    expect(reopened.id).toBe(first.id);
    expect(reopened.reactivatedAt?.[bob.id]).toBe(madeVisible?.reactivatedAt?.[bob.id]);
  });

  it('reactivates a private room for a user who had deleted it, once they reopen it by chat code', async () => {
    const { roomService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const room = await roomService.createPrivateRoom(alice.id, bob.id);
    await roomService.makeVisibleForAll(room, new Date().toISOString());
    await roomService.deleteForUser(room.id, bob.id);

    const reopened = await roomService.createPrivateRoom(bob.id, alice.id);

    expect(reopened.id).toBe(room.id);
    expect(reopened.visibleTo).toContain(bob.id);
    expect(reopened.reactivatedAt?.[bob.id]).toBeDefined();
  });
});

describe('RoomService.filterMessagesForUser', () => {
  it('returns every message when the user has no deletedAt or reactivatedAt entry', async () => {
    const { roomService, messageService, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const room = await roomService.createPrivateRoom(alice.id, bob.id);
    const message = await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content: 'oi' });

    expect(roomService.filterMessagesForUser(room, [message], bob.id)).toEqual([message]);
  });

  it('hides messages sent before the user deleted the room, keeps ones sent after', async () => {
    const { roomService, messageService, messageRepository, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const room = await roomService.createPrivateRoom(alice.id, bob.id);

    const sent1 = await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content: 'antes' });
    const before = await messageRepository.update(sent1.id, { timestamp: '2026-01-01T00:00:00.000Z' });

    const sent2 = await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content: 'depois' });
    const after = await messageRepository.update(sent2.id, { timestamp: '2026-01-03T00:00:00.000Z' });

    if (!before || !after) {
      throw new Error('message not found');
    }

    const roomWithDeletion = { ...room, deletedAt: { [bob.id]: '2026-01-02T00:00:00.000Z' } };

    const filtered = roomService.filterMessagesForUser(roomWithDeletion, [before, after], bob.id);
    expect(filtered.map((message) => message.content)).toEqual(['depois']);
  });

  it('prioritizes reactivatedAt over deletedAt when both are set', async () => {
    const { roomService, messageService, messageRepository, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const room = await roomService.createPrivateRoom(alice.id, bob.id);

    const sent = await messageService.sendMessage({ roomId: room.id, senderId: alice.id, content: 'meio' });
    const midMessage = await messageRepository.update(sent.id, { timestamp: '2026-01-03T00:00:00.000Z' });
    if (!midMessage) {
      throw new Error('message not found');
    }

    const roomWithReactivation = {
      ...room,
      deletedAt: { [bob.id]: '2026-01-04T00:00:00.000Z' },
      reactivatedAt: { [bob.id]: '2026-01-02T00:00:00.000Z' },
    };

    const filtered = roomService.filterMessagesForUser(roomWithReactivation, [midMessage], bob.id);
    expect(filtered).toEqual([midMessage]);
  });

  it('hides messages sent before a group member joined, keeps ones sent after', async () => {
    const { roomService, messageService, messageRepository, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const group = await roomService.createGroupRoom('Amigos', alice.id);

    const sent1 = await messageService.sendMessage({ roomId: group.id, senderId: alice.id, content: 'antes de Bob entrar' });
    const before = await messageRepository.update(sent1.id, { timestamp: '2026-01-01T00:00:00.000Z' });

    const { room: groupWithBob } = await roomService.joinByCode(group.roomCode ?? '', bob.id);
    const withStampedJoin = { ...groupWithBob, joinedAt: { ...groupWithBob.joinedAt, [bob.id]: '2026-01-02T00:00:00.000Z' } };

    const sent2 = await messageService.sendMessage({ roomId: group.id, senderId: alice.id, content: 'depois de Bob entrar' });
    const after = await messageRepository.update(sent2.id, { timestamp: '2026-01-03T00:00:00.000Z' });

    if (!before || !after) {
      throw new Error('message not found');
    }

    const filtered = roomService.filterMessagesForUser(withStampedJoin, [before, after], bob.id);
    expect(filtered.map((message) => message.content)).toEqual(['depois de Bob entrar']);
  });

  it('prioritizes deletedAt over joinedAt when both are set', async () => {
    const { roomService, messageService, messageRepository, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const group = await roomService.createGroupRoom('Amigos', alice.id);
    await roomService.joinByCode(group.roomCode ?? '', bob.id);

    const sent = await messageService.sendMessage({ roomId: group.id, senderId: alice.id, content: 'meio' });
    const midMessage = await messageRepository.update(sent.id, { timestamp: '2026-01-03T00:00:00.000Z' });
    if (!midMessage) {
      throw new Error('message not found');
    }

    const roomWithDeletion = {
      ...group,
      joinedAt: { [bob.id]: '2026-01-01T00:00:00.000Z' },
      deletedAt: { [bob.id]: '2026-01-04T00:00:00.000Z' },
    };

    const filtered = roomService.filterMessagesForUser(roomWithDeletion, [midMessage], bob.id);
    expect(filtered).toEqual([]);
  });
});
