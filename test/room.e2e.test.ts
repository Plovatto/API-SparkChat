import { describe, expect, it } from 'vitest';
import type { RoomKeyPublication } from '@/modules/rooms/room.e2e.js';
import { buildRoomService } from './support/build-room-service.js';
import { fakeEnvelope, newKeyId } from './support/room-keys.js';

type Services = Awaited<ReturnType<typeof buildRoomService>>;

async function createUser(userService: Services['userService'], nickname: string) {
  const { user } = await userService.registerAccount({
    nickname,
    avatar: 0,
    password: 'correct-horse-battery-staple',
  });
  return user;
}

function publication(roomId: string, senderId: string, recipients: string[], epoch = 1, keyId = newKeyId()): RoomKeyPublication {
  return {
    mode: 'generation',
    roomId,
    keyId,
    epoch,
    senderId,
    keys: recipients.map((userId) => ({ userId, sealedKey: fakeEnvelope({ roomId, keyId, epoch, senderId, recipientId: userId }) })),
  };
}

function share(roomId: string, senderId: string, recipients: string[], epoch: number, keyId?: string): RoomKeyPublication {
  return { ...publication(roomId, senderId, recipients, epoch, keyId), mode: 'share' };
}

async function groupOfThree() {
  const services = await buildRoomService();
  const alice = await createUser(services.userService, 'Alice');
  const bob = await createUser(services.userService, 'Bob');
  const carol = await createUser(services.userService, 'Carol');
  const group = await services.roomService.createGroupRoom('Amigos', alice.id);
  await services.roomService.joinByCode(group.roomCode ?? '', bob.id);
  await services.roomService.joinByCode(group.roomCode ?? '', carol.id);
  return { ...services, alice, bob, carol, group };
}

describe('RoomKeyRepository generations', () => {
  it('starts a room without any generation', async () => {
    const { roomKeyRepository, group, alice } = await groupOfThree();

    expect(await roomKeyRepository.getState(group.id)).toEqual({ currentEpoch: 0, currentKeyId: null, rotationRequired: null });
    expect(await roomKeyRepository.findForParticipantInRooms([group.id], alice.id)).toEqual([]);
  });

  it('stores the first complete batch as generation 1 and makes it current', async () => {
    const { roomKeyRepository, roomService, group, alice, bob, carol } = await groupOfThree();
    const batch = publication(group.id, alice.id, [alice.id, bob.id, carol.id]);

    expect(await roomKeyRepository.publish(batch)).toBe('generation');
    expect(await roomKeyRepository.getState(group.id)).toEqual({ currentEpoch: 1, currentKeyId: batch.keyId, rotationRequired: null });
    expect(await roomService.getRoomById(group.id)).toMatchObject({ currentEpoch: 1, currentKeyId: batch.keyId });
    expect(await roomKeyRepository.findForParticipantInRooms([group.id], bob.id)).toEqual([
      { roomId: group.id, keyId: batch.keyId, epoch: 1, senderId: alice.id, sealedKey: batch.keys[1]?.sealedKey },
    ]);
  });

  it('rejects a batch that misses a current member, names an outsider or repeats a member', async () => {
    const { roomKeyRepository, userService, group, alice, bob, carol } = await groupOfThree();
    const outsider = await createUser(userService, 'Mallory');

    expect(await roomKeyRepository.publish(publication(group.id, alice.id, [alice.id, bob.id]))).toBe('incomplete');
    expect(await roomKeyRepository.publish(publication(group.id, alice.id, [alice.id, bob.id, carol.id, outsider.id]))).toBe('incomplete');
    expect(await roomKeyRepository.publish(publication(group.id, alice.id, [alice.id, bob.id, bob.id]))).toBe('incomplete');
    expect(await roomKeyRepository.getState(group.id)).toMatchObject({ currentEpoch: 0 });
    expect(await roomKeyRepository.findForParticipantInRooms([group.id], alice.id)).toEqual([]);
  });

  it('keeps the first complete batch for an epoch and rejects later ones', async () => {
    const { roomKeyRepository, group, alice, bob, carol } = await groupOfThree();
    const first = publication(group.id, alice.id, [alice.id, bob.id, carol.id]);
    const second = publication(group.id, bob.id, [alice.id, bob.id, carol.id]);

    expect(await roomKeyRepository.publish(first)).toBe('generation');
    expect(await roomKeyRepository.publish(second)).toBe('stale');
    expect(await roomKeyRepository.getState(group.id)).toMatchObject({ currentEpoch: 1, currentKeyId: first.keyId });
    expect((await roomKeyRepository.findForParticipantInRooms([group.id], carol.id)).map((key) => key.keyId)).toEqual([first.keyId]);
  });

  it('lets exactly one of two concurrent batches for the same epoch win', async () => {
    const { roomKeyRepository, group, alice, bob, carol } = await groupOfThree();
    const members = [alice.id, bob.id, carol.id];

    const outcomes = await Promise.all([
      roomKeyRepository.publish(publication(group.id, alice.id, members)),
      roomKeyRepository.publish(publication(group.id, bob.id, members)),
    ]);

    expect(outcomes.sort()).toEqual(['generation', 'stale']);
    expect(await roomKeyRepository.findForParticipantInRooms([group.id], carol.id)).toHaveLength(1);
  });

  it('accepts a new epoch only after a rotation was required, and only the next one', async () => {
    const { roomKeyRepository, group, alice, bob, carol } = await groupOfThree();
    const members = [alice.id, bob.id, carol.id];
    await roomKeyRepository.publish(publication(group.id, alice.id, members));

    expect(await roomKeyRepository.publish(publication(group.id, alice.id, members, 2))).toBe('stale');
    expect(await roomKeyRepository.markRotationRequired(group.id)).toEqual({ roomId: group.id, epoch: 2 });
    expect(await roomKeyRepository.publish(publication(group.id, alice.id, members, 3))).toBe('stale');
    expect(await roomKeyRepository.publish(publication(group.id, alice.id, members, 1))).toBe('stale');

    const rotation = publication(group.id, bob.id, members, 2);
    expect(await roomKeyRepository.publish(rotation)).toBe('generation');
    expect(await roomKeyRepository.getState(group.id)).toEqual({ currentEpoch: 2, currentKeyId: rotation.keyId, rotationRequired: null });
    expect((await roomKeyRepository.findForParticipantInRooms([group.id], carol.id)).map((key) => key.epoch)).toEqual([1, 2]);
  });

  it('never treats a generation batch as a share or a share as a new generation', async () => {
    const { roomKeyRepository, group, alice, bob, carol } = await groupOfThree();
    const members = [alice.id, bob.id, carol.id];

    expect(await roomKeyRepository.publish(share(group.id, alice.id, members, 1))).toBe('stale');
    const first = publication(group.id, alice.id, members);
    await roomKeyRepository.publish(first);
    expect(await roomKeyRepository.publish(publication(group.id, alice.id, [bob.id], 1, first.keyId))).toBe('stale');
    await roomKeyRepository.markRotationRequired(group.id);
    expect(await roomKeyRepository.publish(share(group.id, alice.id, members, 2))).toBe('stale');
    expect(await roomKeyRepository.getState(group.id)).toMatchObject({ currentEpoch: 1, currentKeyId: first.keyId });
  });

  it('does not require a rotation before the first generation exists', async () => {
    const { roomKeyRepository, group } = await groupOfThree();

    expect(await roomKeyRepository.markRotationRequired(group.id)).toBeNull();
    expect(await roomKeyRepository.getState(group.id)).toMatchObject({ rotationRequired: null });
  });
});

describe('RoomKeyRepository sharing the current generation', () => {
  async function groupWithLateMember() {
    const services = await groupOfThree();
    const { roomKeyRepository, roomService, userService, group, alice, bob, carol } = services;
    const current = publication(group.id, alice.id, [alice.id, bob.id, carol.id]);
    await roomKeyRepository.publish(current);
    const dave = await createUser(userService, 'Dave');
    await roomService.joinByCode(group.roomCode ?? '', dave.id);
    return { ...services, current, dave };
  }

  it('lets a holder share the current generation with a member who has no copy', async () => {
    const { roomKeyRepository, group, current, bob, dave } = await groupWithLateMember();

    expect(await roomKeyRepository.publish(share(group.id, bob.id, [dave.id], 1, current.keyId))).toBe('share');
    expect(await roomKeyRepository.findForParticipantInRooms([group.id], dave.id)).toMatchObject([{ keyId: current.keyId, epoch: 1, senderId: bob.id }]);
    expect(await roomKeyRepository.getState(group.id)).toMatchObject({ currentEpoch: 1, rotationRequired: null });
  });

  it('never replaces a copy someone already has', async () => {
    const { roomKeyRepository, group, current, bob, carol } = await groupWithLateMember();
    const before = await roomKeyRepository.findForParticipantInRooms([group.id], carol.id);

    expect(await roomKeyRepository.publish(share(group.id, bob.id, [carol.id], 1, current.keyId))).toBe('conflict');
    expect(await roomKeyRepository.findForParticipantInRooms([group.id], carol.id)).toEqual(before);
  });

  it('refuses shares from someone who does not hold the generation, to outsiders, or of a stale key', async () => {
    const { roomKeyRepository, userService, group, current, bob, dave } = await groupWithLateMember();
    const outsider = await createUser(userService, 'Mallory');

    expect(await roomKeyRepository.publish(share(group.id, dave.id, [dave.id], 1, current.keyId))).toBe('conflict');
    expect(await roomKeyRepository.publish(share(group.id, bob.id, [outsider.id], 1, current.keyId))).toBe('conflict');
    expect(await roomKeyRepository.publish(share(group.id, bob.id, [dave.id], 1))).toBe('stale');
    expect(await roomKeyRepository.findForParticipantInRooms([group.id], dave.id)).toEqual([]);
  });
});

describe('RoomKeyRepository lookups', () => {
  it('returns keys only for rooms where the user is a participant, in the requested order', async () => {
    const services = await buildRoomService();
    const { roomService, roomKeyRepository, userService } = services;
    const alice = await createUser(userService, 'Alice');
    const bob = await createUser(userService, 'Bob');
    const carol = await createUser(userService, 'Carol');
    const aliceBob = await roomService.createPrivateRoom(alice.id, bob.id);
    const bobCarol = await roomService.createPrivateRoom(bob.id, carol.id);
    const aliceCarol = await roomService.createPrivateRoom(alice.id, carol.id);
    const first = publication(aliceBob.id, alice.id, [alice.id, bob.id]);
    const second = publication(aliceCarol.id, carol.id, [alice.id, carol.id]);
    await roomKeyRepository.publish(first);
    await roomKeyRepository.publish(publication(bobCarol.id, bob.id, [bob.id, carol.id]));
    await roomKeyRepository.publish(second);

    const keys = await roomKeyRepository.findForParticipantInRooms([aliceCarol.id, bobCarol.id, 'unknown-room', aliceBob.id], alice.id);

    expect(keys.map((key) => [key.roomId, key.keyId])).toEqual([
      [aliceCarol.id, second.keyId],
      [aliceBob.id, first.keyId],
    ]);
    expect(await roomKeyRepository.findForParticipantInRooms([], alice.id)).toEqual([]);
  });

  it('returns a stored envelope with the sender keys and whether the sender is still a member', async () => {
    const { roomKeyRepository, roomService, userService, group, alice, bob, carol } = await groupOfThree();
    await userService.publishE2eKeys(alice.id, { publicKey: 'alice-public' });
    const batch = publication(group.id, alice.id, [alice.id, bob.id, carol.id]);
    await roomKeyRepository.publish(batch);

    expect(await roomKeyRepository.findForUser(group.id, bob.id, batch.keyId)).toMatchObject({
      keyId: batch.keyId,
      epoch: 1,
      senderId: alice.id,
      senderPublicKey: 'alice-public',
      senderIsMember: true,
    });

    await roomService.leaveGroup(group.id, alice.id);
    expect(await roomKeyRepository.findForUser(group.id, bob.id, batch.keyId)).toMatchObject({ senderIsMember: false });
    expect(await roomKeyRepository.findForUser(group.id, bob.id, newKeyId())).toBeNull();
  });
});
