import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { roomParticipants, rooms } from '@/database/schema.js';
import { buildRoomService } from './support/build-room-service.js';
import { establishFakeGeneration } from './support/room-keys.js';
import { TEST_V2_SIGNUP } from './support/test-constants.js';

type Services = Awaited<ReturnType<typeof buildRoomService>>;

async function createUser(services: Services, nickname: string) {
  const { user } = await services.userService.registerAccount({ nickname, avatar: 0, password: 'correct-horse-battery-staple-0123456789abcd', ...TEST_V2_SIGNUP });
  return user;
}

async function groupWithMember(services: Services) {
  const alice = await createUser(services, 'Alice');
  const bob = await createUser(services, 'Bob');
  const group = await services.roomService.createGroupRoom('Amigos', alice.id);
  await services.joinGroup(group.id, bob.id);
  await services.roomService.promoteAdmin(group.id, alice.id, bob.id);
  return { alice, bob, group };
}

describe('room membership changes', () => {
  it('never brings back a removed member when a stale update for that member runs afterwards', async () => {
    const services = await buildRoomService();
    const { roomService, roomRepository } = services;
    const { alice, bob, group } = await groupWithMember(services);
    const snapshot = await roomService.getRoomById(group.id);
    if (!snapshot) {
      throw new Error('room not found');
    }

    await roomService.removeMember(group.id, alice.id, bob.id);
    await roomRepository.updateParticipant(group.id, bob.id, { isVisible: false, deletedAt: new Date().toISOString() });
    await roomService.resetVisibilityForUser(snapshot, bob.id);
    await roomService.makeVisibleForAll(snapshot, new Date().toISOString());

    const room = await roomService.getRoomById(group.id);
    expect(room?.participants).toEqual([alice.id]);
    expect(room?.admins).toEqual([alice.id]);
  });

  it('keeps a removed member out when removal and the member own updates race', async () => {
    const services = await buildRoomService();
    const { roomService } = services;
    const { alice, bob, group } = await groupWithMember(services);

    await Promise.all([
      roomService.deleteForUser(group.id, bob.id),
      roomService.removeMember(group.id, alice.id, bob.id),
      roomService.deleteForUser(group.id, bob.id),
      roomService.deleteForUser(group.id, bob.id),
    ]);

    const room = await roomService.getRoomById(group.id);
    expect(room?.participants).toEqual([alice.id]);
    expect(await roomService.getVisibleRoomsForUser(bob.id)).toEqual([]);
  });

  it('refuses to add a banned user even through the repository', async () => {
    const services = await buildRoomService();
    const { roomService, roomRepository, joinGroup } = services;
    const { alice, bob, group } = await groupWithMember(services);
    await roomService.removeMember(group.id, alice.id, bob.id);

    expect(await roomRepository.addParticipant(group.id, bob.id, new Date().toISOString())).toBe(false);
    await expect(joinGroup(group.id, bob.id)).rejects.toMatchObject({ code: 'room.notFound' });
  });

  it('ignores a leftover participant row of a banned user on every membership check', async () => {
    const services = await buildRoomService();
    const { roomService, roomKeyRepository, db } = services;
    const { alice, bob, group } = await groupWithMember(services);
    await establishFakeGeneration(roomKeyRepository, group.id, alice.id, [alice.id, bob.id]);
    await roomService.removeMember(group.id, alice.id, bob.id);
    await db.insert(roomParticipants).values({ roomId: group.id, userId: bob.id, isVisible: true, isAdmin: true });

    expect((await roomService.getRoomById(group.id))?.participants).toEqual([alice.id]);
    expect(await roomService.getVisibleRoomsForUser(bob.id)).toEqual([]);
    expect(await roomService.findParticipatingRoomIds(bob.id, [group.id])).toEqual(new Set());
    expect(await roomService.getContactIds(bob.id)).toEqual([bob.id]);
    expect(await roomKeyRepository.findForParticipantInRooms([group.id], bob.id)).toEqual([]);

    const normalized = await roomService.normalizeMembershipsAndRoomCodes();
    expect(normalized.purgedParticipants).toBe(1);
  });

  it('clears blocks set by a member who leaves without touching other rows', async () => {
    const services = await buildRoomService();
    const { roomService, roomRepository } = services;
    const { alice, bob, group } = await groupWithMember(services);
    await roomRepository.updateParticipant(group.id, alice.id, { blockedByUserId: bob.id });

    const after = await roomService.leaveGroup(group.id, bob.id);

    expect(after?.participants).toEqual([alice.id]);
    expect(after?.blockedBy).toEqual({});
  });
});

describe('group room codes', () => {
  it('clears every group room code, once, so codes stop granting access to groups', async () => {
    const services = await buildRoomService();
    const { roomService, roomRepository, db } = services;
    const alice = await createUser(services, 'Alice');
    const legacy = await roomService.createGroupRoom('Antigo', alice.id);
    const modern = await roomService.createGroupRoom('Novo', alice.id);
    await db.update(rooms).set({ roomCode: 'ABCD1234XY' }).where(eq(rooms.id, legacy.id));

    const first = await roomService.normalizeMembershipsAndRoomCodes();
    const second = await roomService.normalizeMembershipsAndRoomCodes();

    expect(first.clearedCodes).toBe(1);
    expect(second.clearedCodes).toBe(0);
    expect(await roomRepository.findByRoomCode('ABCD1234XY')).toBeNull();
    expect((await roomService.getRoomById(legacy.id))?.roomCode).toBeUndefined();
    expect((await roomService.getRoomById(modern.id))?.roomCode).toBeUndefined();
  });
});
