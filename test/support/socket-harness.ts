import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import { getSodium } from '@/modules/ai/ai.crypto.js';
import { AiRouter } from '@/modules/ai/ai.provider.js';
import { AiService } from '@/modules/ai/ai.service.js';
import { AiUsageLimiter } from '@/modules/ai/ai.usage-limiter.js';
import { MessageRateLimiter, RecordingService, RoomPresenceService, TypingService } from '@/modules/messages/index.js';
import { RoomActionRateLimiter } from '@/modules/rooms/index.js';
import { LoginRateLimiter } from '@/modules/users/index.js';
import type { AppServer } from '@/sockets/events.js';
import { registerSocketHandlers } from '@/sockets/index.js';
import { buildRoomService } from './build-room-service.js';

export const TEST_PASSWORD = 'correct-horse-battery-staple';

export type TestClient = ClientSocket;

export interface SocketHarnessOptions {
  messageRateLimiter?: MessageRateLimiter;
  roomRateLimiter?: RoomActionRateLimiter;
  connectionStateRecovery?: boolean;
}

export async function startSocketHarness(options: SocketHarnessOptions = {}) {
  const services = await buildRoomService();
  const sodium = await getSodium();
  const keyPair = sodium.crypto_box_keypair();
  const aiService = new AiService(
    { userId: 'assistant-not-in-tests', publicKey: sodium.to_base64(keyPair.publicKey), publicKeyBytes: keyPair.publicKey, privateKey: keyPair.privateKey },
    services.roomKeyRepository,
    services.messageService,
    new TypingService(),
    new RoomPresenceService(),
    new AiRouter([{ generateReply: () => Promise.resolve('ok') }]),
    new AiUsageLimiter(),
    services.objectStorage,
  );

  const httpServer = createServer();
  const io: AppServer = new Server(
    httpServer,
    options.connectionStateRecovery ? { connectionStateRecovery: { maxDisconnectionDuration: 60_000, skipMiddlewares: true } } : {},
  );
  const typingService = new TypingService();
  const recordingService = new RecordingService();
  const presenceService = new RoomPresenceService();
  registerSocketHandlers(io, {
    userService: services.userService,
    roomService: services.roomService,
    messageService: services.messageService,
    typingService,
    recordingService,
    presenceService,
    loginRateLimiter: new LoginRateLimiter(),
    messageRateLimiter: options.messageRateLimiter ?? new MessageRateLimiter(),
    roomRateLimiter: options.roomRateLimiter ?? new RoomActionRateLimiter(),
    roomKeyRepository: services.roomKeyRepository,
    aiService,
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  const clients: TestClient[] = [];

  async function connect(auth: Record<string, unknown> = {}): Promise<TestClient> {
    const client = connectClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false, auth });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('connect_error', reject);
    });
    return client;
  }

  async function createAccount(nickname: string) {
    const { user, sessionToken, sessionId } = await services.userService.registerAccount({ nickname, avatar: 0, password: TEST_PASSWORD });
    return { user, sessionToken, sessionId };
  }

  async function resume(client: TestClient, userId: string, sessionToken: string): Promise<void> {
    const resumed = waitForEvent(client, 'user:resumed');
    client.emit('user:join', { mode: 'resume', userId, sessionToken });
    await resumed;
  }

  async function connectAs(account: { user: { id: string }; sessionToken: string }, auth: Record<string, unknown> = {}): Promise<TestClient> {
    const client = await connect(auth);
    await resume(client, account.user.id, account.sessionToken);
    return client;
  }

  async function close(): Promise<void> {
    for (const client of clients) {
      client.disconnect();
    }
    await new Promise<void>((resolve) => {
      void io.close(() => resolve());
    });
  }

  return { ...services, io, typingService, recordingService, presenceService, connect, connectAs, createAccount, resume, close };
}

export function waitForEvent<T = unknown>(
  client: TestClient,
  event: string,
  predicate: (payload: T) => boolean = () => true,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off(event, listener);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const listener = (payload: T) => {
      if (!predicate(payload)) {
        return;
      }
      clearTimeout(timer);
      client.off(event, listener);
      resolve(payload);
    };
    client.on(event, listener);
  });
}

export function collectEvents<T = unknown>(client: TestClient, event: string): T[] {
  const received: T[] = [];
  client.on(event, (payload: T) => received.push(payload));
  return received;
}

export function waitForDisconnect(client: TestClient, timeoutMs = 3000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (client.disconnected) {
      resolve('already disconnected');
      return;
    }
    const timer = setTimeout(() => reject(new Error('timed out waiting for disconnect')), timeoutMs);
    client.once('disconnect', (reason) => {
      clearTimeout(timer);
      resolve(reason);
    });
  });
}

export async function roundTrip(client: TestClient): Promise<void> {
  const done = waitForEvent(client, 'e2e:my-keys');
  client.emit('e2e:get-my-keys');
  await done;
}

export function settle(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
