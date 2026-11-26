import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiRouter } from '@/modules/ai/ai.provider.js';
import { createFakeServer, setupAssistantRoom } from './support/ai-fixture.js';
import { sealAttachmentBytes } from './support/room-keys.js';

type History = { role: string; text?: string; inlineData?: { mimeType: string; data: string }[] }[];

async function setup() {
  const generate = vi.fn(() => Promise.resolve({ text: 'ok', calls: [] }));
  const context = await setupAssistantRoom({ router: new AiRouter([{ generate }]) });
  return { ...context, generate };
}

async function lastTurn(generate: ReturnType<typeof vi.fn>): Promise<History[number] | undefined> {
  await vi.advanceTimersByTimeAsync(3000);
  await vi.waitFor(() => {
    expect(generate).toHaveBeenCalledTimes(1);
  });
  const [history] = generate.mock.calls[0] as unknown as [History];
  return history.at(-1);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AiService per-attachment keys', () => {
  async function sendTextFile(context: Awaited<ReturnType<typeof setup>>, messageId: string, url: string, key: string | undefined) {
    return context.messageService.sendMessage({
      roomId: context.room.id,
      senderId: context.alice.id,
      messageId,
      content: url,
      type: 'file',
      fileMeta: {
        name: await context.sealFromAlice('notes.txt', messageId, 'file-name'),
        mimeType: await context.sealFromAlice('text/plain', messageId, 'file-mime'),
        size: 32,
        ...(key ? { key } : {}),
      },
    });
  }

  it('reads the file key from the decrypted message fields and decrypts the object', async () => {
    const context = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const messageId = randomUUID();
    const { url, key } = await context.storeSealedAttachment('uploads/files/notes.txt', Buffer.from('segredo do arquivo'), messageId);

    const message = await sendTextFile(context, messageId, url, key);
    await context.aiService.handleIncomingMessage(createFakeServer(), context.room, message, 'pt');

    expect((await lastTurn(context.generate))?.text).toContain('segredo do arquivo');
  });

  it('decrypts an image with its own key and sends it inline', async () => {
    const context = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const messageId = randomUUID();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const { url, key } = await context.storeSealedAttachment('uploads/images/pixel.png', png, messageId);

    const message = await context.messageService.sendMessage({
      roomId: context.room.id,
      senderId: context.alice.id,
      messageId,
      content: url,
      type: 'image',
      fileMeta: {
        name: await context.sealFromAlice('pixel.png', messageId, 'file-name'),
        mimeType: await context.sealFromAlice('image/png', messageId, 'file-mime'),
        size: png.length,
        key,
      },
    });
    await context.aiService.handleIncomingMessage(createFakeServer(), context.room, message, 'pt');

    expect((await lastTurn(context.generate))?.inlineData).toHaveLength(1);
  });

  it('does not decrypt an attachment whose message carries no file key', async () => {
    const context = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const messageId = randomUUID();
    const { url } = await context.storeSealedAttachment('uploads/files/notes.txt', Buffer.from('segredo do arquivo'), messageId);

    const message = await sendTextFile(context, messageId, url, undefined);
    await context.aiService.handleIncomingMessage(createFakeServer(), context.room, message, 'pt');

    const turn = await lastTurn(context.generate);
    expect(turn?.text).not.toContain('segredo do arquivo');
    expect(turn?.text).toContain('não foi possível carregá-lo');
  });

  it('refuses a file key that is not sealed for this message', async () => {
    const context = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const messageId = randomUUID();
    const { url, rawKey } = await context.storeSealedAttachment('uploads/files/notes.txt', Buffer.from('segredo do arquivo'), messageId);
    const keyForAnotherMessage = await context.sealFromAlice(rawKey, randomUUID(), 'file-key');

    const message = await sendTextFile(context, messageId, url, keyForAnotherMessage);
    await context.aiService.handleIncomingMessage(createFakeServer(), context.room, message, 'pt');

    expect((await lastTurn(context.generate))?.text).not.toContain('segredo do arquivo');
  });

  it('refuses an object sealed for another message even with the right key', async () => {
    const context = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const messageId = randomUUID();
    const sealed = await sealAttachmentBytes(Buffer.from('segredo do arquivo'), { roomId: context.room.id, messageId: randomUUID(), slot: 'content' });
    const url = `${await context.storeUpload(context.alice.id, 'uploads/files/moved.txt', sealed.bytes)}?e2e=1`;

    const message = await sendTextFile(context, messageId, url, await context.sealFromAlice(sealed.fileKey, messageId, 'file-key'));
    await context.aiService.handleIncomingMessage(createFakeServer(), context.room, message, 'pt');

    expect((await lastTurn(context.generate))?.text).not.toContain('segredo do arquivo');
  });
});
