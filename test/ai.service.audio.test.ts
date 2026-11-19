import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSodium } from '@/modules/ai/ai.crypto.js';
import { AiRouter } from '@/modules/ai/ai.provider.js';
import { createFakeServer, setupAssistantRoom } from './support/ai-fixture.js';

async function setup() {
  const generateReply = vi.fn(() => Promise.resolve('ok'));
  const context = await setupAssistantRoom({ router: new AiRouter([{ generateReply }]) });
  const sodium = await getSodium();

  async function storeEncryptedAudio(key: string): Promise<string> {
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const sealed = sodium.crypto_secretbox_easy(Buffer.from('voice bytes'), nonce, context.roomKey);
    const url = await context.storeUpload(context.alice.id, key, Buffer.concat([Buffer.from(context.keyId, 'base64url'), Buffer.from(nonce), Buffer.from(sealed)]));
    return `${url}?e2e=1`;
  }

  return { ...context, generateReply, storeEncryptedAudio };
}

async function lastInlineMimeType(generateReply: ReturnType<typeof vi.fn>): Promise<string | undefined> {
  await vi.advanceTimersByTimeAsync(3000);
  await vi.waitFor(() => {
    expect(generateReply).toHaveBeenCalledTimes(1);
  });
  const [history] = generateReply.mock.calls[0] as unknown as [{ inlineData?: { mimeType: string }[] }[]];
  return history.at(-1)?.inlineData?.[0]?.mimeType;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AiService audio attachments', () => {
  it('takes the audio type from the encrypted file metadata when the url has no extension', async () => {
    const { aiService, messageService, room, alice, generateReply, storeEncryptedAudio, sealFromAlice } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const content = await storeEncryptedAudio('uploads/audio/voice.bin');
    const messageId = randomUUID();

    const message = await messageService.sendMessage({
      roomId: room.id,
      senderId: alice.id,
      messageId,
      content,
      type: 'audio',
      duration: 3,
      fileMeta: {
        name: await sealFromAlice('audio-1', messageId, 'file-name'),
        mimeType: await sealFromAlice('audio/ogg;codecs=opus', messageId, 'file-mime'),
        size: 11,
      },
    });
    aiService.handleIncomingMessage(createFakeServer(), room, message, 'pt');

    expect(await lastInlineMimeType(generateReply)).toBe('audio/ogg');
  });

  it('falls back to the url extension when the declared audio type is not usable', async () => {
    const { aiService, messageService, room, alice, generateReply, storeEncryptedAudio, sealFromAlice } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const content = await storeEncryptedAudio('uploads/audio/voice.webm');
    const messageId = randomUUID();

    const message = await messageService.sendMessage({
      roomId: room.id,
      senderId: alice.id,
      messageId,
      content,
      type: 'audio',
      duration: 3,
      fileMeta: {
        name: await sealFromAlice('audio-2', messageId, 'file-name'),
        mimeType: await sealFromAlice('application/octet-stream', messageId, 'file-mime'),
        size: 11,
      },
    });
    aiService.handleIncomingMessage(createFakeServer(), room, message, 'pt');

    expect(await lastInlineMimeType(generateReply)).toBe('audio/webm');
  });
});
