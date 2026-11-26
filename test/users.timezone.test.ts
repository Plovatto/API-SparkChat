import { afterEach, describe, expect, it } from 'vitest';
import { listSocketEvents } from '@/docs/socket-registry.js';
import { roundTrip, startSocketHarness, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function setup() {
  harness = await startSocketHarness();
  const alice = await harness.createAccount('Alice');
  return { h: harness, alice };
}

async function emitTimeZone(client: TestClient, payload: unknown): Promise<void> {
  client.emit('user:set-timezone', payload);
  await roundTrip(client);
}

describe('user time zone', () => {
  it('falls back to America/Sao_Paulo when none is stored', async () => {
    const { h, alice } = await setup();

    expect(await h.userService.getTimeZone(alice.user.id)).toBe('America/Sao_Paulo');
  });

  it('persists a valid zone sent with user:set-timezone', async () => {
    const { h, alice } = await setup();
    const client = await h.connectAs(alice);

    await emitTimeZone(client, { timeZone: 'America/New_York' });

    expect(await h.userService.getTimeZone(alice.user.id)).toBe('America/New_York');
  });

  it('rejects an unknown zone and keeps the previous one', async () => {
    const { h, alice } = await setup();
    const client = await h.connectAs(alice);
    await emitTimeZone(client, { timeZone: 'Europe/Lisbon' });

    await emitTimeZone(client, { timeZone: 'Mars/Olympus' });
    await emitTimeZone(client, { timeZone: 42 });

    expect(await h.userService.getTimeZone(alice.user.id)).toBe('Europe/Lisbon');
  });

  it('persists a valid zone from the handshake once the session is bound', async () => {
    const { h, alice } = await setup();

    await h.connectAs(alice, { timeZone: 'Asia/Tokyo' });

    expect(await h.userService.getTimeZone(alice.user.id)).toBe('Asia/Tokyo');
  });

  it('ignores an invalid zone from the handshake', async () => {
    const { h, alice } = await setup();

    await h.connectAs(alice, { timeZone: 'Mars/Olympus' });

    expect(await h.userService.getTimeZone(alice.user.id)).toBe('America/Sao_Paulo');
  });

  it('registers the event in the socket docs', () => {
    expect(listSocketEvents().some((event) => event.event === 'user:set-timezone' && event.direction === 'client-to-server')).toBe(true);
  });
});
