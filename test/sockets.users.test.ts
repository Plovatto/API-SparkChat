import { afterEach, describe, expect, it } from 'vitest';
import { listSocketEvents } from '@/docs/socket-registry.js';
import { socketLocale } from '@/sockets/socket-locale.js';
import { roundTrip, startSocketHarness, waitForEvent, type TestClient } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

let harness: Harness | null = null;

async function start(): Promise<Harness> {
  harness = await startSocketHarness();
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function serverLocaleOf(h: Harness, client: TestClient) {
  const serverSocket = h.io.sockets.sockets.get(client.id ?? '');
  if (!serverSocket) {
    throw new Error('server socket not found');
  }
  return socketLocale(serverSocket);
}

describe('user:set-locale', () => {
  it('switches the connection locale used by SparkAI', async () => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const client = await h.connectAs(alice, { locale: 'pt' });

    client.emit('user:set-locale', { locale: 'en' });
    await roundTrip(client);

    expect(serverLocaleOf(h, client)).toBe('en');
  });

  it('works before authentication', async () => {
    const h = await start();
    const client = await h.connect();

    client.emit('user:set-locale', { locale: 'en' });
    const alice = await h.createAccount('Alice');
    await h.resume(client, alice.user.id, alice.sessionToken);

    expect(serverLocaleOf(h, client)).toBe('en');
  });

  it.each([{ locale: 'fr' }, { locale: 'EN' }, {}, null, 'en'])('silently ignores the invalid payload %j', async (payload) => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const client = await h.connectAs(alice, { locale: 'en' });
    let errored = false;
    client.on('error', () => {
      errored = true;
    });

    client.emit('user:set-locale', payload);
    await roundTrip(client);

    expect(serverLocaleOf(h, client)).toBe('en');
    expect(errored).toBe(false);
  });

  it('is documented in the socket events panel', () => {
    const descriptor = listSocketEvents().find((event) => event.event === 'user:set-locale' && event.direction === 'client-to-server');

    expect(descriptor?.payloadSchema).toMatchObject({
      properties: { locale: { enum: ['pt', 'en'] } },
      required: ['locale'],
    });
  });
});

describe('E2EE lookup limits', () => {
  it.each([
    ['e2e:get-room-keys', 'roomIds'],
    ['e2e:get-public-keys', 'userIds'],
  ])('answers %s with e2e.lookupTooLarge when more than 200 ids are sent', async (event, key) => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const client = await h.connectAs(alice);

    const error = waitForEvent(client, 'error');
    client.emit(event, { [key]: Array.from({ length: 201 }, (_, index) => `id-${index}`) });

    await expect(error).resolves.toEqual({
      message: 'Consulta de chaves com itens demais. Envie no máximo 200 por vez.',
      code: 'e2e.lookupTooLarge',
      params: { maxItems: 200 },
      event,
    });
  });

  it.each([
    ['e2e:get-room-keys', 'roomIds', 'e2e:room-keys'],
    ['e2e:get-public-keys', 'userIds', 'e2e:public-keys'],
  ])('still answers %s with exactly 200 ids', async (event, key, responseEvent) => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const client = await h.connectAs(alice);

    const response = waitForEvent(client, responseEvent);
    client.emit(event, { [key]: Array.from({ length: 200 }, (_, index) => `id-${index}`) });

    await expect(response).resolves.toEqual({ keys: [] });
  });

  it.each([
    ['e2e:get-room-keys', 'roomIds'],
    ['e2e:get-public-keys', 'userIds'],
  ])('tags other validation errors of %s with the originating event', async (event, key) => {
    const h = await start();
    const alice = await h.createAccount('Alice');
    const client = await h.connectAs(alice);

    const error = waitForEvent(client, 'error');
    client.emit(event, { [key]: [] });

    await expect(error).resolves.toMatchObject({ code: 'validation.invalidPayload', event });
  });
});
