const USER_AGENT = 'SparkChatLinkPreview/1.0 (+https://sparkchat.app)';

export async function fetchWithGuard(url: URL, timeoutMs: number, accept: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
    });
  } finally {
    clearTimeout(timeout);
  }
}

interface ByteStreamReader {
  read(): Promise<{ done: boolean; value: Uint8Array | undefined }>;
  cancel(): Promise<void>;
}

export async function readBodyBuffer(response: Response, maxBytes: number, truncateOk: boolean): Promise<Buffer | null> {
  const reader = response.body?.getReader() as ByteStreamReader | undefined;
  if (!reader) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }

    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      if (!truncateOk) {
        return null;
      }
      const overflow = received - maxBytes;
      chunks.push(Buffer.from(value.subarray(0, value.byteLength - overflow)));
      break;
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}
