import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptableAttestation, withAttestation, type AttestationExpectation } from '@/modules/rooms/room.event-attestation.js';
import { systemEvent } from '@/modules/messages/index.js';
import { fakeProof, seedInvite } from './support/invites.js';
import { startSocketHarness, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

interface SystemMessage {
  type: string;
  systemEvent: { type: string; params: Record<string, string | null> } | null;
}

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function attestation(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    roomId: 'room-1',
    epoch: 3,
    type: 'group.memberRemoved',
    actorId: 'alice',
    targetId: 'carol',
    counter: 1700000000000,
    sig: randomBytes(64).toString('base64url'),
    ...overrides,
  });
}

const expectation: AttestationExpectation = { roomId: 'room-1', actorId: 'alice', type: 'group.memberRemoved', targetId: 'carol' };

describe('acceptableAttestation', () => {
  it('accepts a well-formed attestation that matches the action', () => {
    const raw = attestation();
    expect(acceptableAttestation(raw, expectation)).toBe(raw);
  });

  it.each([
    ['another room', { roomId: 'room-2' }],
    ['another actor', { actorId: 'mallory' }],
    ['another event type', { type: 'group.memberLeft' }],
    ['another target', { targetId: 'bob' }],
    ['a missing target', { targetId: null }],
    ['a negative counter', { counter: -1 }],
    ['a fractional epoch', { epoch: 1.5 }],
    ['an unknown version', { v: 2 }],
    ['a short signature', { sig: 'abc' }],
  ])('drops an attestation with %s', (_label, change) => {
    expect(acceptableAttestation(attestation(change), expectation)).toBeNull();
  });

  it('drops garbage and absent attestations', () => {
    expect(acceptableAttestation('not json', expectation)).toBeNull();
    expect(acceptableAttestation('[]', expectation)).toBeNull();
    expect(acceptableAttestation(undefined, expectation)).toBeNull();
  });

  it('only touches the event params when there is an attestation to attach', () => {
    const event = systemEvent('group.memberLeft', { actor: 'Alice' });
    expect(withAttestation(event, null)).toBe(event);
    expect(withAttestation(event, 'x').params).toEqual({ actor: 'Alice', att: 'x' });
  });
});

async function setupGroup(h: Harness) {
  const alice = await h.createAccount('Alice');
  const bob = await h.createAccount('Bob');
  const carol = await h.createAccount('Carol');
  const aliceClient = await h.connectAs(alice);
  const bobClient = await h.connectAs(bob);
  const created = waitForEvent<{ room: { id: string } }>(aliceClient, 'room:created');
  aliceClient.emit('room:create-group', {});
  const roomId = (await created).room.id;
  const { inviteToken } = await seedInvite(h.db, roomId);
  const joinedRoom = async (client: TestClient, userId: string, extra: Record<string, unknown> = {}) => {
    const message = waitForEvent<SystemMessage>(aliceClient, 'message:new', (m) => m.systemEvent?.type === 'group.memberJoined');
    client.emit('room:join-by-invite', { roomId, inviteToken, proof: fakeProof(userId), ...extra });
    return message;
  };
  return { alice, bob, carol, aliceClient, bobClient, roomId, joinedRoom };
}

function body(roomId: string, type: string, actorId: string, targetId: string | null = null): string {
  return attestation({ roomId, type, actorId, targetId });
}

describe('attested group system events over sockets', () => {
  it('relays a valid join attestation and leaves old clients unaffected', async () => {
    const h = (harness = await startSocketHarness());
    const { bob, bobClient, roomId, joinedRoom } = await setupGroup(h);
    const att = body(roomId, 'group.memberJoined', bob.user.id);

    const message = await joinedRoom(bobClient, bob.user.id, { attestation: att });

    expect(message.systemEvent?.params.att).toBe(att);
    expect(message.systemEvent?.params.actor).toBe('Bob');
  });

  it('drops a join attestation naming another actor but still records the join', async () => {
    const h = (harness = await startSocketHarness());
    const { alice, bob, bobClient, roomId, joinedRoom } = await setupGroup(h);

    const message = await joinedRoom(bobClient, bob.user.id, { attestation: body(roomId, 'group.memberJoined', alice.user.id) });

    expect(message.systemEvent?.params).toEqual({ actor: 'Bob' });
  });

  it('relays admin attestations on promote and remove and member attestations on leave', async () => {
    const h = (harness = await startSocketHarness());
    const { alice, bob, carol, aliceClient, bobClient, roomId, joinedRoom } = await setupGroup(h);
    const carolClient = await h.connectAs(carol);
    await joinedRoom(bobClient, bob.user.id);
    await joinedRoom(carolClient, carol.user.id);

    const promoteAtt = body(roomId, 'group.adminPromoted', alice.user.id, bob.user.id);
    const promoted = waitForEvent<SystemMessage>(bobClient, 'message:new', (m) => m.systemEvent?.type === 'group.adminPromoted');
    aliceClient.emit('group:promote-admin', { roomId, userId: bob.user.id, attestation: promoteAtt });
    expect((await promoted).systemEvent?.params.att).toBe(promoteAtt);

    const removeAtt = body(roomId, 'group.memberRemoved', alice.user.id, carol.user.id);
    const removed = waitForEvent<SystemMessage>(bobClient, 'message:new', (m) => m.systemEvent?.type === 'group.memberRemoved');
    aliceClient.emit('group:remove-member', { roomId, userId: carol.user.id, attestation: removeAtt });
    expect((await removed).systemEvent?.params.att).toBe(removeAtt);

    const leaveAtt = body(roomId, 'group.memberLeft', bob.user.id);
    const left = waitForEvent<SystemMessage>(aliceClient, 'message:new', (m) => m.systemEvent?.type === 'group.memberLeft');
    bobClient.emit('group:leave', { roomId, attestation: leaveAtt });
    expect((await left).systemEvent?.params.att).toBe(leaveAtt);
  });

  it('does not let a member attach an attestation for a different target or type', async () => {
    const h = (harness = await startSocketHarness());
    const { alice, bob, carol, aliceClient, bobClient, roomId, joinedRoom } = await setupGroup(h);
    const carolClient = await h.connectAs(carol);
    await joinedRoom(bobClient, bob.user.id);
    await joinedRoom(carolClient, carol.user.id);

    const removed = waitForEvent<SystemMessage>(bobClient, 'message:new', (m) => m.systemEvent?.type === 'group.memberRemoved');
    aliceClient.emit('group:remove-member', { roomId, userId: carol.user.id, attestation: body(roomId, 'group.memberRemoved', alice.user.id, bob.user.id) });

    expect((await removed).systemEvent?.params).toEqual({ target: 'Carol', actor: 'Alice' });
  });

  it('still processes actions that carry no attestation', async () => {
    const h = (harness = await startSocketHarness());
    const { bob, bobClient, aliceClient, roomId, joinedRoom } = await setupGroup(h);
    await joinedRoom(bobClient, bob.user.id);

    const left = waitForEvent<SystemMessage>(aliceClient, 'message:new', (m) => m.systemEvent?.type === 'group.memberLeft');
    bobClient.emit('group:leave', { roomId });

    expect((await left).systemEvent?.params).toEqual({ actor: 'Bob' });
  });

  it('rejects an oversized attestation at the payload boundary', async () => {
    const h = (harness = await startSocketHarness());
    const { bob, bobClient, aliceClient, roomId, joinedRoom } = await setupGroup(h);
    await joinedRoom(bobClient, bob.user.id);

    const failed = waitForEvent<{ code?: string }>(bobClient, 'error');
    bobClient.emit('group:leave', { roomId, attestation: 'x'.repeat(5000) });
    await failed;

    expect((await h.roomService.getRoomById(roomId))?.participants).toContain(bob.user.id);
    expect(aliceClient.connected).toBe(true);
  });
});
