import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveKeyId, getSodium, readFieldKeyId, sealField } from '@/modules/ai/ai.crypto.js';
import { ensureAssistantUser } from '@/modules/ai/ai.identity.js';
import { AiRouter } from '@/modules/ai/ai.provider.js';
import type { AiConversationMessage } from '@/modules/ai/ai.provider.js';
import { createFakeServer, setupAssistantRoom } from './support/ai-fixture.js';
import { createIdentity, sealEnvelope } from './support/room-keys.js';
import { TEST_V2_SIGNUP } from './support/test-constants.js';

const PAST_RETRIES_MS = 5000;

async function setup() {
  const histories: AiConversationMessage[][] = [];
  const router = new AiRouter([
    {
      generateReply: (messages) => {
        histories.push(messages);
        return Promise.resolve('resposta');
      },
    },
  ]);
  const context = await setupAssistantRoom({ router });
  return { ...context, histories };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(PAST_RETRIES_MS);
}

async function errorTypes(context: Awaited<ReturnType<typeof setup>>): Promise<(string | undefined)[]> {
  const { messages } = await context.messageService.getRoomMessagesPage(context.room.id, { limit: 50 });
  return messages.filter((message) => message.type === 'error').map((message) => message.systemEvent?.type);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SparkAI with authenticated room keys', () => {
  it('reads a v2 message from the user and replies with a v2 message signed by its own key under the current key id', async () => {
    const context = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });

    const message = await context.sendFromAlice('qual é a capital da França?');
    await context.aiService.handleIncomingMessage(createFakeServer(), context.room, message, 'pt');
    await flush();

    await vi.waitFor(async () => {
      expect(await context.assistantTexts()).toEqual(['resposta']);
    });
    expect(context.histories[0]?.at(-1)?.text).toBe('qual é a capital da França?');
    const { messages } = await context.messageService.getRoomMessagesPage(context.room.id, { limit: 10 });
    const reply = messages.find((record) => record.senderId === context.assistant.id);
    expect(reply && readFieldKeyId(reply.content)).toBe(context.keyId);
  });

  it('skips history entries whose signature is not from their claimed sender', async () => {
    const context = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const mallory = await createIdentity('mallory');
    const forgedId = randomUUID();
    await context.messageService.sendMessage({
      roomId: context.room.id,
      senderId: context.alice.id,
      messageId: forgedId,
      content: await sealField('mensagem forjada', context.roomKey, context.keyId, mallory.signingPrivateKey, {
        roomId: context.room.id,
        senderId: context.alice.id,
        messageId: forgedId,
        label: 'content',
      }),
    });

    const message = await context.sendFromAlice('mensagem real');
    await context.aiService.handleIncomingMessage(createFakeServer(), context.room, message, 'pt');
    await flush();

    await vi.waitFor(() => {
      expect(context.histories).toHaveLength(1);
    });
    expect(context.histories[0]?.map((entry) => entry.text)).toEqual(['mensagem real']);
  });

  it('ignores an envelope that was not sealed by a member of the room', async () => {
    const context = await setupAssistantRoom({ publishKey: false });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { user: mallory } = await context.userService.registerAccount({ nickname: 'Mallory', avatar: 2, password: 'correct-horse-battery-staple-0123456789abcd', ...TEST_V2_SIGNUP });
    const malloryIdentity = await createIdentity(mallory.id);
    await context.userRepository.update(mallory.id, {
      e2ePublicKey: malloryIdentity.publicKey,
      e2eSigningPublicKey: malloryIdentity.signingPublicKey,
      e2eKeySignature: malloryIdentity.keySignature,
    });
    const keyId = await deriveKeyId(context.roomKey);
    const envelope = (recipientId: string, recipientPublicKey: string) =>
      sealEnvelope({ roomId: context.room.id, keyId, epoch: 1, roomKey: context.roomKey, sender: malloryIdentity, recipientId, recipientPublicKey });
    await context.roomKeyRepository.publish({
      mode: 'generation',
      roomId: context.room.id,
      keyId,
      epoch: 1,
      senderId: mallory.id,
      keys: [
        { userId: context.alice.id, sealedKey: await envelope(context.alice.id, context.aliceIdentity.publicKey) },
        { userId: context.assistant.id, sealedKey: await envelope(context.assistant.id, context.identity.publicKey) },
      ],
    });

    const sending = context.aiService.sendWelcomeMessage(createFakeServer(), context.room, 'pt');
    await flush();
    await sending;

    expect(await context.assistantTexts()).toEqual([]);
  });

  it('keeps reading older generations after a rotation and answers with the new one', async () => {
    const context = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const sodium = await getSodium();
    await context.sendFromAlice('antes da rotação');

    await context.roomKeyRepository.markRotationRequired(context.room.id);
    const nextKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const nextKeyId = await deriveKeyId(nextKey);
    const envelope = (recipientId: string, recipientPublicKey: string) =>
      sealEnvelope({ roomId: context.room.id, keyId: nextKeyId, epoch: 2, roomKey: nextKey, sender: context.aliceIdentity, recipientId, recipientPublicKey });
    await context.roomKeyRepository.publish({
      mode: 'generation',
      roomId: context.room.id,
      keyId: nextKeyId,
      epoch: 2,
      senderId: context.alice.id,
      keys: [
        { userId: context.alice.id, sealedKey: await envelope(context.alice.id, context.aliceIdentity.publicKey) },
        { userId: context.assistant.id, sealedKey: await envelope(context.assistant.id, context.identity.publicKey) },
      ],
    });
    const messageId = randomUUID();
    const message = await context.messageService.sendMessage({
      roomId: context.room.id,
      senderId: context.alice.id,
      messageId,
      content: await sealField('depois da rotação', nextKey, nextKeyId, context.aliceIdentity.signingPrivateKey, {
        roomId: context.room.id,
        senderId: context.alice.id,
        messageId,
        label: 'content',
      }),
    });

    await context.aiService.handleIncomingMessage(createFakeServer(), context.room, message, 'pt');
    await flush();

    await vi.waitFor(() => {
      expect(context.histories).toHaveLength(1);
    });
    expect(context.histories[0]?.map((entry) => entry.text)).toEqual(['antes da rotação', 'depois da rotação']);
    const { messages } = await context.messageService.getRoomMessagesPage(context.room.id, { limit: 10 });
    const reply = messages.find((record) => record.senderId === context.assistant.id);
    expect(reply && readFieldKeyId(reply.content)).toBe(nextKeyId);
  });

  it('does not send with a generation that is waiting to be rotated', async () => {
    const context = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const message = await context.sendFromAlice('oi');
    await context.roomKeyRepository.markRotationRequired(context.room.id);

    await context.aiService.handleIncomingMessage(createFakeServer(), context.room, message, 'pt');
    await flush();
    await vi.advanceTimersByTimeAsync(PAST_RETRIES_MS);

    await vi.waitFor(async () => {
      expect(await errorTypes(context)).toEqual(['ai.encryptionUnavailable']);
    });
    expect(await context.assistantTexts()).toEqual([]);
  });
});

describe('ensureAssistantUser', () => {
  it('keeps the room generations when the assistant identity is unchanged', async () => {
    const context = await setupAssistantRoom();

    expect(await ensureAssistantUser(context.userRepository, context.identity)).toEqual([]);

    expect(await context.roomKeyRepository.getState(context.room.id)).toMatchObject({ currentEpoch: 1, rotationRequired: null });
  });

  it('publishes the new signing key and requires a rotation in its rooms when its identity key changes', async () => {
    const context = await setupAssistantRoom();
    const replacement = await createIdentity(context.assistant.id);

    expect(await ensureAssistantUser(context.userRepository, replacement)).toEqual([{ roomId: context.room.id, epoch: 2 }]);

    expect(await context.userRepository.findById(context.assistant.id)).toMatchObject({
      e2ePublicKey: replacement.publicKey,
      e2eSigningPublicKey: replacement.signingPublicKey,
      e2eKeySignature: replacement.keySignature,
    });
    expect(await context.roomKeyRepository.getState(context.room.id)).toMatchObject({ currentEpoch: 1, rotationRequired: 2 });
  });
});
