import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SOCKET_PER_MESSAGE_DEFLATE } from '@/sockets/socket-options.js';
import { startSocketHarness } from './support/socket-harness.js';

type Harness = Awaited<ReturnType<typeof startSocketHarness>>;

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function negotiatedExtensions(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const upgrade = request({
      host: '127.0.0.1',
      port,
      path: '/socket.io/?EIO=4&transport=websocket',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
      },
    });
    upgrade.once('upgrade', (response, socket) => {
      socket.destroy();
      resolve(String(response.headers['sec-websocket-extensions'] ?? ''));
    });
    upgrade.once('response', (response) => reject(new Error(`unexpected status ${response.statusCode}`)));
    upgrade.once('error', reject);
    upgrade.end();
  });
}

describe('socket transport compression', () => {
  it('negotiates per-message deflate without context takeover for large frames only', async () => {
    harness = await startSocketHarness();

    const extensions = await negotiatedExtensions(harness.port);

    expect(extensions).toContain('permessage-deflate');
    expect(extensions).toContain('server_no_context_takeover');
    expect(extensions).toContain('client_no_context_takeover');
    expect(SOCKET_PER_MESSAGE_DEFLATE.threshold).toBe(1024);
  });
});
