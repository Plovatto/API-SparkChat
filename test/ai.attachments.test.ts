import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { getSodium } from '@/modules/ai/ai.crypto.js';
import {
  attachmentAssociatedData,
  guessMimeTypeFromUrl,
  loadDecryptedAttachment,
  resolveAudioMimeType,
  resolveObjectKey,
} from '@/modules/ai/ai.attachments.js';
import { InMemoryObjectStorage } from '@/storage/object-storage.js';
import { sealAttachmentBytes } from './support/room-keys.js';

describe('guessMimeTypeFromUrl', () => {
  it('maps known image and audio extensions', () => {
    expect(guessMimeTypeFromUrl('https://cdn.test/uploads/images/abc.png')).toBe('image/png');
    expect(guessMimeTypeFromUrl('https://cdn.test/uploads/audio/abc.webm?e2e=1')).toBe('audio/webm');
    expect(guessMimeTypeFromUrl('https://cdn.test/uploads/files/abc.zip')).toBeNull();
  });
});

describe('resolveAudioMimeType', () => {
  it('prefers the declared audio type and drops codec parameters', () => {
    expect(resolveAudioMimeType('audio/webm;codecs=opus', 'https://cdn.test/uploads/audio/abc.bin?e2e=1')).toBe('audio/webm');
    expect(resolveAudioMimeType('audio/x-wav', 'https://cdn.test/uploads/audio/abc.bin?e2e=1')).toBe('audio/wav');
  });

  it('falls back to the url extension when the declared type is missing or not audio', () => {
    expect(resolveAudioMimeType(null, 'https://cdn.test/uploads/audio/abc.m4a?e2e=1')).toBe('audio/mp4');
    expect(resolveAudioMimeType('text/html', 'https://cdn.test/uploads/audio/abc.ogg')).toBe('audio/ogg');
  });

  it('returns null when neither source names a supported audio type', () => {
    expect(resolveAudioMimeType('application/octet-stream', 'https://cdn.test/uploads/audio/abc.bin?e2e=1')).toBeNull();
    expect(resolveAudioMimeType(null, 'https://cdn.test/uploads/images/abc.png')).toBeNull();
  });
});

describe('resolveObjectKey', () => {
  it('resolves an uploaded media url to its object key', () => {
    expect(resolveObjectKey('https://cdn.test/uploads/images/abc.png')).toBe('uploads/images/abc.png');
    expect(resolveObjectKey('https://cdn.test/uploads/audio/abc.webm?e2e=1')).toBe('uploads/audio/abc.webm');
  });

  it('rejects a url outside the uploaded-media namespace', () => {
    expect(resolveObjectKey('https://cdn.test/secrets.env')).toBeNull();
  });

  it('rejects a path traversal attempt', () => {
    expect(resolveObjectKey('https://cdn.test/uploads/../../secrets.env')).toBeNull();
  });

  it('rejects a value that does not point into the uploads namespace', () => {
    expect(resolveObjectKey('/etc/passwd')).toBeNull();
  });
});

const BINDING = { roomId: 'room-1', messageId: '6f1c2d3e-4b5a-4c6d-8e7f-001122334455', slot: 'content' } as const;

async function storeSealed(objectStorage: InMemoryObjectStorage, objectKey: string, bytes: Buffer): Promise<string> {
  await objectStorage.putObject(objectKey, bytes, { contentType: 'application/octet-stream' });
  return `${objectStorage.publicUrl(objectKey)}?e2e=1`;
}

describe('attachmentAssociatedData', () => {
  it('binds the object to the room, the message and the slot', () => {
    expect(attachmentAssociatedData(BINDING)).toBe('sparkchat:attachment:v1|room-1|6f1c2d3e-4b5a-4c6d-8e7f-001122334455|content');
  });
});

describe('loadDecryptedAttachment', () => {
  it('decrypts an object sealed with its own file key and bound to the message', async () => {
    const objectStorage = new InMemoryObjectStorage();
    const { bytes, fileKey } = await sealAttachmentBytes(Buffer.from('fake image bytes'), BINDING);
    const url = await storeSealed(objectStorage, 'uploads/images/photo.png', bytes);

    const result = await loadDecryptedAttachment(url, BINDING, fileKey, objectStorage, 1024 * 1024);

    expect(result?.toString('utf8')).toBe('fake image bytes');
  });

  it('returns null for a wrong file key', async () => {
    const objectStorage = new InMemoryObjectStorage();
    const { bytes } = await sealAttachmentBytes(Buffer.from('fake image bytes'), BINDING);
    const url = await storeSealed(objectStorage, 'uploads/images/photo.png', bytes);

    expect(await loadDecryptedAttachment(url, BINDING, randomBytes(32).toString('base64url'), objectStorage, 1024 * 1024)).toBeNull();
  });

  it('returns null when the object is bound to another message, room or slot', async () => {
    const objectStorage = new InMemoryObjectStorage();
    const { bytes, fileKey } = await sealAttachmentBytes(Buffer.from('fake image bytes'), BINDING);
    const url = await storeSealed(objectStorage, 'uploads/images/photo.png', bytes);

    expect(await loadDecryptedAttachment(url, { ...BINDING, messageId: 'another-message' }, fileKey, objectStorage, 1024 * 1024)).toBeNull();
    expect(await loadDecryptedAttachment(url, { ...BINDING, roomId: 'room-2' }, fileKey, objectStorage, 1024 * 1024)).toBeNull();
    expect(await loadDecryptedAttachment(url, { ...BINDING, slot: 'thumbnail' }, fileKey, objectStorage, 1024 * 1024)).toBeNull();
  });

  it('asks storage to stop reading once the object exceeds the sealed size cap', async () => {
    const objectStorage = new InMemoryObjectStorage();
    const { bytes, fileKey } = await sealAttachmentBytes(Buffer.from('fake image bytes'), BINDING);
    const url = await storeSealed(objectStorage, 'uploads/images/photo.png', bytes);
    const getObject = vi.spyOn(objectStorage, 'getObject');

    await loadDecryptedAttachment(url, BINDING, fileKey, objectStorage, 1024);

    expect(getObject).toHaveBeenCalledWith('uploads/images/photo.png', { maxBytes: 1024 + 40 });
  });

  it('refuses a missing or malformed file key without reading the object', async () => {
    const objectStorage = new InMemoryObjectStorage();
    const { bytes } = await sealAttachmentBytes(Buffer.from('fake image bytes'), BINDING);
    const url = await storeSealed(objectStorage, 'uploads/images/photo.png', bytes);
    const getObject = vi.spyOn(objectStorage, 'getObject');

    expect(await loadDecryptedAttachment(url, BINDING, null, objectStorage, 1024)).toBeNull();
    expect(await loadDecryptedAttachment(url, BINDING, 'short', objectStorage, 1024)).toBeNull();
    expect(await loadDecryptedAttachment(url, BINDING, `${'A'.repeat(42)}=`, objectStorage, 1024)).toBeNull();
    expect(getObject).not.toHaveBeenCalled();
  });

  it('no longer opens objects sealed with the room key and a key id header', async () => {
    const objectStorage = new InMemoryObjectStorage();
    const sodium = await getSodium();
    const roomKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const legacy = Buffer.concat([Buffer.alloc(16, 7), Buffer.from(nonce), Buffer.from(sodium.crypto_secretbox_easy(Buffer.from('bytes'), nonce, roomKey))]);
    const url = await storeSealed(objectStorage, 'uploads/images/legacy.png', legacy);

    expect(await loadDecryptedAttachment(url, BINDING, Buffer.from(roomKey).toString('base64url'), objectStorage, 1024)).toBeNull();
  });

  it('returns null for a missing, truncated or oversized object', async () => {
    const objectStorage = new InMemoryObjectStorage();
    const fileKey = randomBytes(32).toString('base64url');
    await objectStorage.putObject('uploads/images/short.png', Buffer.alloc(20), { contentType: 'image/png' });
    const big = await sealAttachmentBytes(Buffer.alloc(2048), BINDING);
    const bigUrl = await storeSealed(objectStorage, 'uploads/images/big.png', big.bytes);

    expect(await loadDecryptedAttachment(`${objectStorage.publicUrl('uploads/images/missing.png')}?e2e=1`, BINDING, fileKey, objectStorage, 1024)).toBeNull();
    expect(await loadDecryptedAttachment(`${objectStorage.publicUrl('uploads/images/short.png')}?e2e=1`, BINDING, fileKey, objectStorage, 1024)).toBeNull();
    expect(await loadDecryptedAttachment(bigUrl, BINDING, big.fileKey, objectStorage, 1024)).toBeNull();
    expect(await loadDecryptedAttachment(bigUrl, BINDING, big.fileKey, objectStorage, 4096)).not.toBeNull();
  });
});
