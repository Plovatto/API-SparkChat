import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSessionExpirySweep, sweepExpiredSocketSessions } from '@/sockets/session-expiry.js';
import { settle, startSocketHarness, waitForDisconnect, waitForEvent } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

let harness: Harness | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await harness?.close();
  harness = null;
});

describe('socket session expiry sweep', () => {
  it('disconnects a socket whose session is no longer active', async () => {
    harness = await startSocketHarness();
    const h = harness;
    const alice = await h.createAccount('Alice');
    const client = await h.connectAs(alice);

    const revoked = waitForEvent(client, 'user:session-revoked');
    const disconnected = waitForDisconnect(client);
    await sweepExpiredSocketSessions(h.io, () => Promise.resolve(false));

    await revoked;
    await disconnected;
  });

  it('keeps sockets with a live session and anonymous sockets connected', async () => {
    harness = await startSocketHarness();
    const h = harness;
    const alice = await h.createAccount('Alice');
    const bob = await h.createAccount('Bob');
    const aliceClient = await h.connectAs(alice);
    const bobClient = await h.connectAs(bob);
    const anonymous = await h.connect();

    await sweepExpiredSocketSessions(h.io, (userId) => Promise.resolve(userId === alice.user.id));
    await settle(100);

    expect(aliceClient.connected).toBe(true);
    expect(anonymous.connected).toBe(true);
    expect(bobClient.connected).toBe(false);
  });

  it('checks each session only once per sweep', async () => {
    harness = await startSocketHarness();
    const h = harness;
    const alice = await h.createAccount('Alice');
    await h.connectAs(alice);
    await h.connectAs(alice);
    const isActive = vi.fn(() => Promise.resolve(true));

    await sweepExpiredSocketSessions(h.io, isActive);

    expect(isActive).toHaveBeenCalledTimes(1);
    expect(isActive).toHaveBeenCalledWith(alice.user.id, alice.sessionId);
  });

  it('runs the sweep on an interval until stopped', async () => {
    harness = await startSocketHarness();
    const h = harness;
    const alice = await h.createAccount('Alice');
    await h.connectAs(alice);
    const isActive = vi.fn(() => Promise.resolve(true));

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const stop = startSessionExpirySweep(h.io, isActive, 1000);
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(isActive).toHaveBeenCalledTimes(1));
    stop();
    vi.advanceTimersByTime(5000);

    expect(isActive).toHaveBeenCalledTimes(1);
  });
});
