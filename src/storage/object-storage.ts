export interface PutObjectOptions {
  contentType: string;
  contentDisposition?: string | undefined;
  cacheControl?: string | undefined;
}

export interface GetObjectOptions {
  maxBytes?: number | undefined;
}

export interface ObjectStorage {
  putObject(key: string, body: Buffer, options: PutObjectOptions): Promise<void>;
  getObject(key: string, options?: GetObjectOptions): Promise<Buffer | null>;
  deleteObject(key: string): Promise<void>;
  publicUrl(key: string): string;
}

export class InMemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, { body: Buffer; options: PutObjectOptions }>();

  constructor(private readonly baseUrl: string = 'https://fake-object-storage.test') {}

  putObject(key: string, body: Buffer, options: PutObjectOptions): Promise<void> {
    this.objects.set(key, { body, options });
    return Promise.resolve();
  }

  getObject(key: string, options: GetObjectOptions = {}): Promise<Buffer | null> {
    const body = this.objects.get(key)?.body ?? null;
    if (body && options.maxBytes !== undefined && body.length > options.maxBytes) {
      return Promise.resolve(null);
    }
    return Promise.resolve(body);
  }

  deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  publicUrl(key: string): string {
    return `${this.baseUrl}/${key}`;
  }
}
