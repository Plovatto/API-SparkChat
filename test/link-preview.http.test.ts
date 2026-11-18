import dns, { type LookupAddress } from 'node:dns';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pinnedLookup, pinnedTransport } from '@/modules/link-preview/link-preview.http.js';

type LookupCallback = (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;

function stubResolution(addresses: LookupAddress[]): void {
  vi.spyOn(dns, 'lookup').mockImplementation(((_hostname: string, _options: unknown, callback: LookupCallback) => {
    callback(null, addresses);
  }) as unknown as typeof dns.lookup);
}

function runLookup(all: boolean): Promise<{ error: Error | null; address: unknown }> {
  return new Promise((resolve) => {
    pinnedLookup('rebind.example', { all }, (error, address) => resolve({ error, address }));
  });
}

let server: Server | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  const running = server;
  server = null;
  if (running) {
    await new Promise((resolve) => running.close(resolve));
  }
});

async function startServer(): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const created = createServer((_req, res) => {
    hits += 1;
    res.end('internal');
  });
  server = created;
  await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve));
  const { port } = created.address() as AddressInfo;
  return { port, hits: () => hits };
}

function request(url: string) {
  return pinnedTransport(new URL(url), { signal: new AbortController().signal, accept: '*/*' });
}

describe('pinnedLookup', () => {
  it('returns the vetted public address', async () => {
    stubResolution([{ address: '93.184.216.34', family: 4 }]);

    const single = await runLookup(false);
    const all = await runLookup(true);

    expect(single).toEqual({ error: null, address: '93.184.216.34' });
    expect(all.address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('rejects a name that resolves to any private address', async () => {
    stubResolution([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);

    const result = await runLookup(true);

    expect(result.error).toBeInstanceOf(Error);
  });
});

describe('pinnedTransport', () => {
  it('never connects when the hostname resolves to a loopback address at connect time', async () => {
    const { port, hits } = await startServer();
    stubResolution([{ address: '127.0.0.1', family: 4 }]);

    await expect(request(`http://rebind.example:${port}/`)).rejects.toThrow();
    expect(hits()).toBe(0);
  });

  it('rejects private IP literals', async () => {
    const { port, hits } = await startServer();

    await expect(request(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    expect(hits()).toBe(0);
  });
});
