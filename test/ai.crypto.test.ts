import { describe, expect, it } from 'vitest';
import { deriveKeyId, getSodium, openField, openRoomKeyEnvelope, readFieldKeyId, sealField, type EnvelopeOpening } from '@/modules/ai/ai.crypto.js';
import { verifyIdentityBinding } from '@/modules/users/user.signing-key.js';
import { createIdentity, newKeyId, sealEnvelope } from './support/room-keys.js';

const CONTEXT = { roomId: 'room-1', senderId: 'alice', messageId: 'message-1', label: 'content' };

async function freshRoomKey(): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
}

describe('authenticated v2 fields with key ids', () => {
  it('round-trips a field and exposes its key id in the prefix', async () => {
    const alice = await createIdentity('alice');
    const roomKey = await freshRoomKey();
    const keyId = newKeyId();

    const sealed = await sealField('olá, spark!', roomKey, keyId, alice.signingPrivateKey, CONTEXT);

    expect(sealed.startsWith(`e2e:v2:${keyId}:`)).toBe(true);
    expect(readFieldKeyId(sealed)).toBe(keyId);
    await expect(openField(sealed, roomKey, alice.signingPublicKeyBytes, CONTEXT)).resolves.toBe('olá, spark!');
  });

  it('binds the key id: a field moved to another key id does not open', async () => {
    const alice = await createIdentity('alice');
    const roomKey = await freshRoomKey();
    const keyId = newKeyId();
    const sealed = await sealField('segredo', roomKey, keyId, alice.signingPrivateKey, CONTEXT);

    const relabeled = sealed.replace(keyId, newKeyId());

    await expect(openField(relabeled, roomKey, alice.signingPublicKeyBytes, CONTEXT)).resolves.toBeNull();
  });

  it('does not open with another room key, another context or another signer', async () => {
    const alice = await createIdentity('alice');
    const mallory = await createIdentity('mallory');
    const roomKey = await freshRoomKey();
    const sealed = await sealField('segredo', roomKey, newKeyId(), alice.signingPrivateKey, CONTEXT);

    await expect(openField(sealed, await freshRoomKey(), alice.signingPublicKeyBytes, CONTEXT)).resolves.toBeNull();
    await expect(openField(sealed, roomKey, alice.signingPublicKeyBytes, { ...CONTEXT, messageId: 'other' })).resolves.toBeNull();
    await expect(openField(sealed, roomKey, alice.signingPublicKeyBytes, { ...CONTEXT, label: 'caption' })).resolves.toBeNull();
    await expect(openField(sealed, roomKey, mallory.signingPublicKeyBytes, CONTEXT)).resolves.toBeNull();
  });

  it('refuses legacy v1 and malformed payloads', async () => {
    const alice = await createIdentity('alice');
    const roomKey = await freshRoomKey();

    expect(readFieldKeyId('e2e:v1:AAAA')).toBeNull();
    expect(readFieldKeyId('texto simples')).toBeNull();
    await expect(openField('e2e:v1:AAAA', roomKey, alice.signingPublicKeyBytes, CONTEXT)).resolves.toBeNull();
  });
});

describe('assistant signing identity', () => {
  it('derives a signing key whose identity binding verifies on the server', async () => {
    const assistant = await createIdentity('spark-ai');

    expect(
      verifyIdentityBinding({
        userId: 'spark-ai',
        publicKey: assistant.publicKey,
        signingPublicKey: assistant.signingPublicKey,
        keySignature: assistant.keySignature,
      }),
    ).toBe(true);
  });
});

describe('room key envelopes v2', () => {
  async function scenario() {
    const alice = await createIdentity('alice');
    const assistant = await createIdentity('spark-ai');
    const roomKey = await freshRoomKey();
    const keyId = await deriveKeyId(roomKey);
    const sealedKey = await sealEnvelope({
      roomId: 'room-1',
      keyId,
      epoch: 3,
      roomKey,
      sender: alice,
      recipientId: assistant.userId,
      recipientPublicKey: assistant.publicKey,
    });
    const opening: EnvelopeOpening = {
      sealedKey,
      roomId: 'room-1',
      keyId,
      epoch: 3,
      senderId: alice.userId,
      senderIsMember: true,
      senderPublicKey: alice.publicKey,
      senderSigningPublicKey: alice.signingPublicKey,
      recipientId: assistant.userId,
      recipientPublicKey: assistant.publicKey,
      recipientPrivateKey: assistant.privateKey,
    };
    return { alice, assistant, roomKey, keyId, sealedKey, opening };
  }

  it('opens an envelope signed by a member and addressed to the assistant', async () => {
    const { roomKey, opening } = await scenario();

    await expect(openRoomKeyEnvelope(opening)).resolves.toEqual(roomKey);
  });

  it('discards an envelope whose signature does not verify with the sender signing key', async () => {
    const { opening } = await scenario();
    const mallory = await createIdentity('mallory');
    const envelope = JSON.parse(opening.sealedKey) as { sig: string };
    const tampered = { ...envelope, sig: envelope.sig.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) };

    await expect(openRoomKeyEnvelope({ ...opening, senderSigningPublicKey: mallory.signingPublicKey })).resolves.toBeNull();
    await expect(openRoomKeyEnvelope({ ...opening, sealedKey: JSON.stringify(tampered) })).resolves.toBeNull();
    await expect(openRoomKeyEnvelope({ ...opening, senderSigningPublicKey: null })).resolves.toBeNull();
  });

  it('discards an envelope from a sender who is not a member', async () => {
    const { opening } = await scenario();

    await expect(openRoomKeyEnvelope({ ...opening, senderIsMember: false })).resolves.toBeNull();
  });

  it('discards an envelope addressed to someone else or sealed for another room', async () => {
    const { alice, roomKey, keyId, opening } = await scenario();
    const bob = await createIdentity('bob');
    const forBob = await sealEnvelope({ roomId: 'room-1', keyId, epoch: 3, roomKey, sender: alice, recipientId: bob.userId, recipientPublicKey: bob.publicKey });

    await expect(openRoomKeyEnvelope({ ...opening, sealedKey: forBob })).resolves.toBeNull();
    await expect(openRoomKeyEnvelope({ ...opening, roomId: 'room-2' })).resolves.toBeNull();
    await expect(openRoomKeyEnvelope({ ...opening, recipientId: 'bob' })).resolves.toBeNull();
  });

  it('discards an envelope whose key id, epoch or sender differ from where it is stored', async () => {
    const { opening } = await scenario();

    await expect(openRoomKeyEnvelope({ ...opening, keyId: newKeyId() })).resolves.toBeNull();
    await expect(openRoomKeyEnvelope({ ...opening, epoch: 4 })).resolves.toBeNull();
    await expect(openRoomKeyEnvelope({ ...opening, senderId: 'bob' })).resolves.toBeNull();
  });

  it('discards an envelope whose key id is not derived from the key it carries', async () => {
    const { alice, assistant, roomKey, opening } = await scenario();
    const wrongKeyId = newKeyId();
    const sealedKey = await sealEnvelope({
      roomId: 'room-1',
      keyId: wrongKeyId,
      epoch: 3,
      roomKey,
      sender: alice,
      recipientId: assistant.userId,
      recipientPublicKey: assistant.publicKey,
    });

    await expect(openRoomKeyEnvelope({ ...opening, sealedKey, keyId: wrongKeyId })).resolves.toBeNull();
  });

  it('derives the key id from the room key as the client does', async () => {
    const sodium = await getSodium();
    const roomKey = new Uint8Array(32).fill(1);
    const expected = sodium.to_base64(sodium.crypto_generichash(32, sodium.from_string('sparkchat:key-id:v1'), roomKey).subarray(0, 16));

    expect(await deriveKeyId(roomKey)).toBe(expected);
    expect(expected).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('discards an envelope signed for an old recipient key', async () => {
    const { opening } = await scenario();
    const rotated = await createIdentity('spark-ai');

    await expect(openRoomKeyEnvelope({ ...opening, recipientPublicKey: rotated.publicKey, recipientPrivateKey: rotated.privateKey })).resolves.toBeNull();
  });
});
