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

describe('RoomKeyRepository', () => {
  it('returns null when no key has been published for a user in a room', async () => {
    const { roomService, roomKeyRepository, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const room = await roomService.createPrivateRoom(alice.id, bob.id);

    expect(await roomKeyRepository.findForUser(room.id, alice.id)).toBeNull();
  });

  it('publishes a sealed key per user and keeps them independent', async () => {
    const { roomService, roomKeyRepository, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const room = await roomService.createPrivateRoom(alice.id, bob.id);

    await roomKeyRepository.publish(room.id, alice.id, 'sealed-for-alice');
    await roomKeyRepository.publish(room.id, bob.id, 'sealed-for-bob');

    expect(await roomKeyRepository.findForUser(room.id, alice.id)).toBe('sealed-for-alice');
    expect(await roomKeyRepository.findForUser(room.id, bob.id)).toBe('sealed-for-bob');
  });

  it('overwrites an existing sealed key for the same user and room on republish', async () => {
    const { roomService, roomKeyRepository, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const room = await roomService.createPrivateRoom(alice.id, bob.id);

    await roomKeyRepository.publish(room.id, alice.id, 'first-key');
    await roomKeyRepository.publish(room.id, alice.id, 'rotated-key');

    expect(await roomKeyRepository.findForUser(room.id, alice.id)).toBe('rotated-key');
  });

  it('keeps keys scoped per room even for the same user', async () => {
    const { roomService, roomKeyRepository, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const carol = await createUser(userService, 'Carol');
    const roomWithBob = await roomService.createPrivateRoom(alice.id, bob.id);
    const roomWithCarol = await roomService.createPrivateRoom(alice.id, carol.id);

    await roomKeyRepository.publish(roomWithBob.id, alice.id, 'key-for-bob-room');
    await roomKeyRepository.publish(roomWithCarol.id, alice.id, 'key-for-carol-room');

    expect(await roomKeyRepository.findForUser(roomWithBob.id, alice.id)).toBe('key-for-bob-room');
    expect(await roomKeyRepository.findForUser(roomWithCarol.id, alice.id)).toBe('key-for-carol-room');
  });
});

describe('RoomKeyRepository.findForParticipantInRooms', () => {
  it('returns keys only for rooms where the user is a participant, in the requested order', async () => {
    const { roomService, roomKeyRepository, userService } = await buildRoomService();
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const carol = await createUser(userService, 'Carol');

    const aliceBob = await roomService.createPrivateRoom(alice.id, bob.id);
    const bobCarol = await roomService.createPrivateRoom(bob.id, carol.id);
    const aliceCarol = await roomService.createPrivateRoom(alice.id, carol.id);

    await roomKeyRepository.publish(aliceBob.id, alice.id, 'key-alice-bob');
    await roomKeyRepository.publish(bobCarol.id, alice.id, 'leaked-key');
    await roomKeyRepository.publish(aliceCarol.id, alice.id, 'key-alice-carol');

    const keys = await roomKeyRepository.findForParticipantInRooms([aliceCarol.id, bobCarol.id, 'unknown-room', aliceBob.id], alice.id);

    expect(keys).toEqual([
      { roomId: aliceCarol.id, sealedKey: 'key-alice-carol' },
      { roomId: aliceBob.id, sealedKey: 'key-alice-bob' },
    ]);
    expect(await roomKeyRepository.findForParticipantInRooms([], alice.id)).toEqual([]);
  });
});
