import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { GetObjectOptions, ObjectStorage, PutObjectOptions } from './object-storage.js';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicBaseUrl: string;
}

async function streamToBuffer(stream: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      return null;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function discardBody(body: unknown): void {
  const destroyable = body as { destroy?: () => void };
  if (typeof destroyable.destroy === 'function') {
    destroyable.destroy();
  }
}

export function createR2ObjectStorage(config: R2Config): ObjectStorage {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  const publicBaseUrl = config.publicBaseUrl.replace(/\/$/, '');

  return {
    async putObject(key: string, body: Buffer, options: PutObjectOptions): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucketName,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          ContentDisposition: options.contentDisposition,
          CacheControl: options.cacheControl,
        }),
      );
    },

    async deleteObject(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucketName, Key: key }));
    },

    async getObject(key: string, options: GetObjectOptions = {}): Promise<Buffer | null> {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: config.bucketName, Key: key }));
        if (!result.Body) {
          return null;
        }
        const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
        if (typeof result.ContentLength === 'number' && result.ContentLength > maxBytes) {
          discardBody(result.Body);
          return null;
        }
        const buffer = await streamToBuffer(result.Body as AsyncIterable<Uint8Array>, maxBytes);
        if (!buffer) {
          discardBody(result.Body);
        }
        return buffer;
      } catch {
        return null;
      }
    },

    publicUrl(key: string): string {
      return `${publicBaseUrl}/${key}`;
    },
  };
}
