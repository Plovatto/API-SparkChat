import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createR2ObjectStorage } from '@/storage/r2-object-storage.js';
import { InMemoryObjectStorage } from '@/storage/object-storage.js';

const CONFIG = {
  accountId: 'account',
  accessKeyId: 'access',
  secretAccessKey: 'secret',
  bucketName: 'bucket',
  publicBaseUrl: 'https://media.test',
};

function countingBody(chunkCount: number, chunkSize: number) {
  const state = { consumed: 0 };
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (let index = 0; index < chunkCount; index += 1) {
      state.consumed += 1;
      await Promise.resolve();
      yield new Uint8Array(chunkSize);
    }
  }
  return { body: chunks(), state };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('R2 object reads with a byte limit', () => {
  it('stops streaming as soon as the object grows past the limit', async () => {
    const { body, state } = countingBody(100, 1024);
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ Body: body } as never);
    const storage = createR2ObjectStorage(CONFIG);

    await expect(storage.getObject('uploads/files/a.bin', { maxBytes: 4096 })).resolves.toBeNull();
    expect(state.consumed).toBeLessThanOrEqual(5);
  });

  it('refuses an object whose declared length is over the limit without reading it', async () => {
    const { body, state } = countingBody(100, 1024);
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ Body: body, ContentLength: 100 * 1024 } as never);
    const storage = createR2ObjectStorage(CONFIG);

    await expect(storage.getObject('uploads/files/a.bin', { maxBytes: 4096 })).resolves.toBeNull();
    expect(state.consumed).toBe(0);
  });

  it('returns the whole object when it fits the limit', async () => {
    const { body } = countingBody(4, 1024);
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ Body: body, ContentLength: 4096 } as never);
    const storage = createR2ObjectStorage(CONFIG);

    const result = await storage.getObject('uploads/files/a.bin', { maxBytes: 4096 });
    expect(result?.length).toBe(4096);
  });
});

describe('in-memory object reads with a byte limit', () => {
  it('returns null for an object over the limit', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.putObject('uploads/files/a.bin', Buffer.alloc(10), { contentType: 'application/octet-stream' });

    await expect(storage.getObject('uploads/files/a.bin', { maxBytes: 9 })).resolves.toBeNull();
    await expect(storage.getObject('uploads/files/a.bin', { maxBytes: 10 })).resolves.toHaveLength(10);
  });
});
