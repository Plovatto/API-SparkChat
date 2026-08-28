import { describe, expect, it } from 'vitest';
import { buildRoomService } from './support/build-room-service.js';

async function createUser(userService: ReturnType<typeof buildRoomService>['userService'], nickname: string) {
  return userService.joinOrCreate({ nickname, avatar: 0, socketId: `socket-${nickname}` });
}

describe('RoomService', () => {
  it('creates a private room between two users', async () => {
    const { roomService, userService } = buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const room = await roomService.createPrivateRoom(alice.id, bob.id);

    expect(room.type).toBe('private');
    expect(room.participants).toEqual([alice.id, bob.id]);
    expect(room.visibleTo).toEqual([alice.id]);
  });

  it('reuses the existing private room instead of duplicating it', async () => {
    const { roomService, userService } = buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');

    const first = await roomService.createPrivateRoom(alice.id, bob.id);
    const second = await roomService.createPrivateRoom(alice.id, bob.id);

    expect(second.id).toBe(first.id);
  });

  it('creates a group room with a generated room code and the creator as participant', async () => {
    const { roomService, userService } = buildRoomService();
    const alice = await createUser(userService, 'Alice');

    const room = await roomService.createGroupRoom('Amigos', alice.id);

    expect(room.type).toBe('group');
    expect(room.name).toBe('Amigos');
    expect(room.roomCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(room.participants).toEqual([alice.id]);
    expect(room.createdBy).toBe(alice.id);
  });

  it('only lists rooms visible to the given user', async () => {
    const { roomService, userService } = buildRoomService();
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
    const { roomService, roomRepository, userService } = buildRoomService();
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
});
