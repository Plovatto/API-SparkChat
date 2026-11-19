import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRoomService } from './support/build-room-service.js';
import { fakeEnvelope, fakeField, fakeInvite, newKeyId } from './support/room-keys.js';

let workDir: string | null = null;

afterEach(async () => {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    workDir = null;
  }
});

async function fileBackedGroup() {
  workDir = await mkdtemp(path.join(tmpdir(), 'sparkchat-db-'));
  const services = await buildRoomService(pathToFileURL(path.join(workDir, 'chat.db')).href);
  const register = async (nickname: string) =>
    (await services.userService.registerAccount({ nickname, avatar: 0, password: 'correct-horse-battery-staple' })).user;
  const alice = await register('Alice');
  const bob = await register('Bob');
  const carol = await register('Carol');
  const dave = await register('Dave');
  const group = await services.roomService.createGroupRoom('Amigos', alice.id);
  for (const member of [bob, carol, dave]) {
    await services.joinGroup(group.id, member.id);
  }
  return { ...services, alice, bob, carol, dave, group };
}

function batch(roomId: string, senderId: string, recipients: string[], epoch: number, keyId = newKeyId()) {
  return recipients.map((userId) => ({ userId, sealedKey: fakeEnvelope({ roomId, keyId, epoch, senderId, recipientId: userId }) }));
}

describe('room key writes on a local file database', () => {
  it('never locks out message writes while keys, removals and identity changes run at the same time', async () => {
    const context = await fileBackedGroup();
    const { roomKeyRepository, roomService, userService, messageService, group, alice, bob, carol, dave } = context;
    const members = [alice.id, bob.id, carol.id, dave.id];
    const keyId = newKeyId();
    await userService.publishE2eKeys(bob.id, { publicKey: 'bob-first' });
    expect(await roomKeyRepository.publish({ mode: 'generation', invite: fakeInvite(), roomId: group.id, keyId, epoch: 1, senderId: alice.id, keys: batch(group.id, alice.id, members, 1, keyId) })).toBe(
      'generation',
    );

    const sends = Array.from({ length: 30 }, (_, index) =>
      messageService.sendMessage({ roomId: group.id, senderId: alice.id, messageId: randomUUID(), content: fakeField(`m${index}`, keyId) }),
    );
    const results = await Promise.allSettled([
      ...sends,
      roomKeyRepository.publish({ mode: 'generation', invite: fakeInvite(), roomId: group.id, keyId: newKeyId(), epoch: 1, senderId: bob.id, keys: batch(group.id, bob.id, members, 1) }),
      roomKeyRepository.publish({ mode: 'share', roomId: group.id, keyId, epoch: 1, senderId: bob.id, keys: batch(group.id, bob.id, [carol.id], 1, keyId) }),
      roomService.leaveGroup(group.id, dave.id),
      userService.publishE2eKeys(bob.id, { publicKey: 'bob-second' }),
      ...sends.map(() => messageService.markRoomAsRead(group.id, bob.id)),
    ]);

    expect(results.filter((result) => result.status === 'rejected').map((result) => String((result).reason))).toEqual([]);
    const { messages } = await messageService.getRoomMessagesPage(group.id, { limit: 100 });
    expect(messages.filter((message) => message.type === 'text')).toHaveLength(30);
    expect(await roomKeyRepository.getState(group.id)).toMatchObject({ currentEpoch: 1, rotationRequired: 2 });
    await expect(userService.registerAccount({ nickname: 'Eva', avatar: 0, password: 'correct-horse-battery-staple' })).resolves.toBeDefined();
  });

  it('keeps the database writable after a key write fails', async () => {
    const context = await fileBackedGroup();
    const { roomKeyRepository, messageService, group, alice, bob, carol, dave } = context;
    const keyId = newKeyId();
    const keys = batch(group.id, alice.id, [alice.id, bob.id, carol.id, dave.id], 1, keyId);

    await expect(
      roomKeyRepository.publish({ mode: 'generation', invite: fakeInvite(), roomId: group.id, keyId, epoch: 1, senderId: alice.id, keys: [...keys, { userId: 'ghost', sealedKey: 'x' }] }),
    ).resolves.toBe('incomplete');
    await expect(
      roomKeyRepository.publish({ mode: 'generation', invite: fakeInvite(), roomId: 'missing-room', keyId, epoch: 1, senderId: alice.id, keys }),
    ).resolves.toBe('stale');

    await expect(messageService.sendMessage({ roomId: group.id, senderId: alice.id, messageId: randomUUID(), content: fakeField('depois') })).resolves.toBeDefined();
  });

  it('rolls back the whole generation and releases the database when a write inside it fails', async () => {
    const context = await fileBackedGroup();
    const { roomKeyRepository, messageService, db, group, alice, bob, carol, dave } = context;
    const keyId = newKeyId();
    await db.run(sql`create trigger block_keys before insert on room_keys begin select raise(abort, 'blocked'); end`);

    await expect(
      roomKeyRepository.publish({ mode: 'generation', invite: fakeInvite(), roomId: group.id, keyId, epoch: 1, senderId: alice.id, keys: batch(group.id, alice.id, [alice.id, bob.id, carol.id, dave.id], 1, keyId) }),
    ).rejects.toThrow();

    expect(await roomKeyRepository.getState(group.id)).toEqual({ currentEpoch: 0, currentKeyId: null, rotationRequired: null });
    await expect(messageService.sendMessage({ roomId: group.id, senderId: alice.id, messageId: randomUUID(), content: fakeField('ainda grava') })).resolves.toBeDefined();
  });
});
