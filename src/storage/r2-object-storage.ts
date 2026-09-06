import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ObjectStorage, PutObjectOptions } from './object-storage.js';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicBaseUrl: string;
}

async function streamToBuffer(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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

    async getObject(key: string): Promise<Buffer | null> {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: config.bucketName, Key: key }));
        if (!result.Body) {
          return null;
        }
        return await streamToBuffer(result.Body as AsyncIterable<Uint8Array>);
      } catch {
        return null;
      }
    },

    publicUrl(key: string): string {
      return `${publicBaseUrl}/${key}`;
    },
  };
}
