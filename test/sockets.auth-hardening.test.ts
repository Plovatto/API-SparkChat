import { afterEach, describe, expect, it } from 'vitest';
import type { AppServer } from '@/sockets/events.js';
import { guardSessionRecovery } from '@/sockets/session-recovery.js';
import {
  collectEvents,
  roundTrip,
  settle,
  startSocketHarness,
  TEST_PASSWORD,
  waitForDisconnect,
  waitForEvent,
  type TestClient,
} from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

let harness: Harness | null = null;

async function start(options: Parameters<typeof startSocketHarness>[0] = {}): Promise<Harness> {
  harness = await startSocketHarness(options);
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function loginAnotherDevice(h: Harness, nickname: string) {
  const result = await h.userService.login(nickname, TEST_PASSWORD);
  if (!result) {
    throw new Error('login failed');
  }
  return result;
}

function serverSocketOf(h: Harness, client: TestClient) {
  const socket = h.io.sockets.sockets.get(client.id ?? '');
  if (!socket) {
    throw new Error('server socket not found');
  }
  return socket;
}

describe('recovery file regeneration over sockets', () => {
  it('refuses to regenerate the recovery file without the current password', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const client = await h.connectAs(alice);
    const regenerated = collectEvents(client, 'user:recovery-file-regenerated');

    const missing = waitForEvent<{ code: string }>(client, 'error');
    client.emit('user:regenerate-recovery-file');
    await expect(missing).resolves.toMatchObject({ code: 'user.currentPasswordIncorrect' });

    const wrong = waitForEvent<{ code: string }>(client, 'error');
    client.emit('user:regenerate-recovery-file', { currentPassword: 'not-the-password' });
    await expect(wrong).resolves.toMatchObject({ code: 'user.currentPasswordIncorrect' });

    expect(regenerated).toHaveLength(0);
  });

  it('regenerates with the current password and disconnects every other session but keeps the tabs of the current one', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const otherSession = await loginAnotherDevice(h, 'Alice');
    const current = await h.connectAs(alice);
    const sameSessionTab = await h.connectAs(alice);
    const otherDevice = await h.connectAs(otherSession);
    const sameTabRevocations = collectEvents(sameSessionTab, 'user:session-revoked');

    const revoked = waitForEvent(otherDevice, 'user:session-revoked');
    const disconnected = waitForDisconnect(otherDevice);
    const regenerated = waitForEvent<{ recoveryFile: string }>(current, 'user:recovery-file-regenerated');
    current.emit('user:regenerate-recovery-file', { currentPassword: TEST_PASSWORD });

    await expect(regenerated).resolves.toMatchObject({ recoveryFile: expect.any(String) as string });
    await revoked;
    await disconnected;
    await roundTrip(sameSessionTab);

    expect(sameTabRevocations).toHaveLength(0);
    await expect(h.userService.isSessionActive(alice.user.id, otherSession.sessionId)).resolves.toBe(false);
    await expect(h.userService.isSessionActive(alice.user.id, alice.sessionId)).resolves.toBe(true);
  });

  it('limits wrong current password attempts per user', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const client = await h.connectAs(alice);

    for (let i = 0; i < 5; i += 1) {
      const failed = waitForEvent<{ code: string }>(client, 'error');
      client.emit('user:regenerate-recovery-file', { currentPassword: `wrong-password-${i}` });
      await expect(failed).resolves.toMatchObject({ code: 'user.currentPasswordIncorrect' });
    }

    const limited = waitForEvent<{ code: string }>(client, 'error');
    client.emit('user:regenerate-recovery-file', { currentPassword: TEST_PASSWORD });
    await expect(limited).resolves.toMatchObject({ code: 'rateLimit.passwordAttempts' });
  });
});

describe('nickname change over sockets', () => {
  it('changes only the avatar without asking for the password', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const client = await h.connectAs(alice);

    const updated = waitForEvent<{ recoveryFile: string | null }>(client, 'user:profile-updated-success');
    client.emit('user:update-profile', { nickname: 'Alice', avatar: 4 });

    await expect(updated).resolves.toMatchObject({ recoveryFile: null });
  });

  it('requires the current password to change the nickname and then disconnects the other sessions', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const otherSession = await loginAnotherDevice(h, 'Alice');
    const current = await h.connectAs(alice);
    const otherDevice = await h.connectAs(otherSession);

    const refused = waitForEvent<{ code: string }>(current, 'error');
    current.emit('user:update-profile', { nickname: 'Alicia', avatar: 0 });
    await expect(refused).resolves.toMatchObject({ code: 'user.currentPasswordIncorrect' });
    expect(otherDevice.connected).toBe(true);

    const disconnected = waitForDisconnect(otherDevice);
    const updated = waitForEvent<{ recoveryFile: string | null }>(current, 'user:profile-updated-success');
    current.emit('user:update-profile', { nickname: 'Alicia', avatar: 0, currentPassword: TEST_PASSWORD });

    await expect(updated).resolves.toMatchObject({ recoveryFile: expect.any(String) as string });
    await disconnected;
    expect(current.connected).toBe(true);
  });
});

describe('password change over sockets', () => {
  it('lets a fresh keyfile session change the password without the current one', async () => {
    const h = await start();
    const { recoveryFile } = await h.userService.registerAccount({ nickname: 'Alice', avatar: 0, password: TEST_PASSWORD });
    const keyfileLogin = await h.userService.loginWithKeyfile(recoveryFile);
    if (!keyfileLogin) {
      throw new Error('keyfile login failed');
    }
    const client = await h.connectAs(keyfileLogin);

    const changed = waitForEvent(client, 'user:password-changed');
    client.emit('user:change-password', { newPassword: 'a-fresh-password-123' });

    await changed;
    await expect(h.userService.login('Alice', 'a-fresh-password-123')).resolves.not.toBeNull();
  });

  it('requires the current password from a password session', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const client = await h.connectAs(alice);

    const refused = waitForEvent<{ code: string }>(client, 'error');
    client.emit('user:change-password', { newPassword: 'a-fresh-password-123' });

    await expect(refused).resolves.toMatchObject({ code: 'user.currentPasswordRequired' });
  });

  it('disconnects a socket of the user even when it is no longer in the user room', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const otherSession = await loginAnotherDevice(h, 'Alice');
    const current = await h.connectAs(alice);
    const strayDevice = await h.connectAs(otherSession);
    await serverSocketOf(h, strayDevice).leave(`user:${alice.user.id}`);

    const disconnected = waitForDisconnect(strayDevice);
    const changed = waitForEvent(current, 'user:password-changed');
    current.emit('user:change-password', { currentPassword: TEST_PASSWORD, newPassword: 'another-long-password-123' });

    await changed;
    await disconnected;
  });
});

describe('session resume hardening', () => {
  it('rate limits resume attempts per socket with a temporary failure', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const client = await h.connect();
    const failures = collectEvents<{ reason: string; code: string }>(client, 'user:auth-failed');

    for (let i = 0; i < 20; i += 1) {
      const failed = waitForEvent(client, 'user:auth-failed');
      client.emit('user:join', { mode: 'resume', userId: alice.user.id, sessionToken: 'not-a-real-token' });
      await failed;
    }

    const limited = waitForEvent<{ reason: string; code: string }>(client, 'user:auth-failed');
    client.emit('user:join', { mode: 'resume', userId: alice.user.id, sessionToken: alice.sessionToken });

    await expect(limited).resolves.toMatchObject({ reason: 'temporary', code: 'rateLimit.resumeAttempts' });
    expect(failures.slice(0, 20).every((failure) => failure.code === 'auth.sessionExpired')).toBe(true);
  });

  it('unbinds and disconnects a socket whose session is revoked while the resume is in flight', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const originalResume = h.userService.resumeSession.bind(h.userService);
    h.userService.resumeSession = async (userId, sessionToken) => {
      const resumed = await originalResume(userId, sessionToken);
      await h.userService.revokeSession(alice.user.id, alice.sessionId);
      return resumed;
    };
    const client = await h.connect();
    const resumedEvents = collectEvents(client, 'user:resumed');

    const revoked = waitForEvent(client, 'user:session-revoked');
    const disconnected = waitForDisconnect(client);
    client.emit('user:join', { mode: 'resume', userId: alice.user.id, sessionToken: alice.sessionToken });
    await revoked;
    await disconnected;
    await settle(50);

    expect(resumedEvents).toHaveLength(0);
    expect(h.io.sockets.adapter.rooms.get(`user:${alice.user.id}`)).toBeUndefined();
  });

  it('does not bind a socket that disconnected while the resume was in flight', async () => {
    const h = await start({ connectionStateRecovery: true });
    const alice = await h.createAccount('Alice');
    const client = await h.connect();
    const serverSocket = serverSocketOf(h, client);
    const originalResume = h.userService.resumeSession.bind(h.userService);
    h.userService.resumeSession = async (userId, sessionToken) => {
      const resumed = await originalResume(userId, sessionToken);
      const serverClosed = new Promise<void>((resolve) => serverSocket.once('disconnect', () => resolve()));
      client.io.engine.close();
      await serverClosed;
      return resumed;
    };

    client.emit('user:join', { mode: 'resume', userId: alice.user.id, sessionToken: alice.sessionToken });
    await waitForDisconnect(client);
    await settle(50);

    expect(serverSocket.data.userId).toBeUndefined();
    expect(h.io.sockets.adapter.rooms.get(`user:${alice.user.id}`)).toBeUndefined();

    h.userService.resumeSession = originalResume;
    const reconnected = new Promise<void>((resolve) => client.once('connect', () => resolve()));
    client.connect();
    await reconnected;

    const refused = waitForEvent<{ code: string }>(client, 'error');
    client.emit('e2e:get-my-keys');
    await expect(refused).resolves.toMatchObject({ code: 'auth.unauthenticated' });
  });
});

describe('guardSessionRecovery', () => {
  function fakeServer(restored: unknown) {
    const adapter = {
      sessions: new Map<string, unknown>(),
      restoreSession: () => Promise.resolve(restored),
    };
    const io = { of: () => ({ adapter }) } as unknown as AppServer;
    return { io, adapter };
  }

  it('refuses to recover an authenticated socket that is missing its user room', async () => {
    const { io, adapter } = fakeServer({ sid: 'sid-1', pid: 'pid-1', rooms: ['sid-1'], data: { userId: 'u-1', sessionId: 's-1' }, missedPackets: [] });
    guardSessionRecovery(io, () => Promise.resolve(true), () => Promise.resolve(new Set()));

    await expect(adapter.restoreSession()).resolves.toBeNull();
  });

  it('recovers an authenticated socket that kept its user room', async () => {
    const session = { sid: 'sid-1', pid: 'pid-1', rooms: ['sid-1', 'user:u-1'], data: { userId: 'u-1', sessionId: 's-1' }, missedPackets: [] };
    const { io, adapter } = fakeServer(session);
    guardSessionRecovery(io, () => Promise.resolve(true), () => Promise.resolve(new Set()));

    await expect(adapter.restoreSession()).resolves.toBe(session);
  });
});

describe('session revocation notifications', () => {
  it('disconnects only the sockets bound to the revoked session', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const otherSession = await loginAnotherDevice(h, 'Alice');
    const tabA = await h.connectAs(alice);
    const tabB = await h.connectAs(alice);
    const otherDevice = await h.connectAs(otherSession);
    const otherRevocations = collectEvents(otherDevice, 'user:session-revoked');

    const revoked = Promise.all([waitForEvent(tabA, 'user:session-revoked'), waitForEvent(tabB, 'user:session-revoked')]);
    const disconnected = Promise.all([waitForDisconnect(tabA), waitForDisconnect(tabB)]);
    h.sessionRevocations.publish({ userId: alice.user.id, sessionId: alice.sessionId });
    await revoked;
    await disconnected;
    await roundTrip(otherDevice);

    expect(otherRevocations).toHaveLength(0);
  });
});
