import dns, { type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { isPrivateAddress } from './link-preview.ssrf-guard.js';

const USER_AGENT = 'SparkChatLinkPreview/1.0 (+https://sparkchat.app)';
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export interface TransportRequest {
  signal: AbortSignal;
  accept: string;
}

export type LinkPreviewTransport = (url: URL, init: TransportRequest) => Promise<Response>;

function blockedAddressError(): Error {
  return new Error('Endereço não permitido.');
}

export const pinnedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) {
      callback(error, '', 0);
      return;
    }

    const first = addresses[0];
    if (!first || addresses.some((entry) => isPrivateAddress(entry.address))) {
      callback(blockedAddressError(), '', 0);
      return;
    }

    if (options.all) {
      callback(null, addresses);
      return;
    }

    callback(null, first.address, first.family);
  });
};

function toHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  return headers;
}

export const pinnedTransport: LinkPreviewTransport = (url, { signal, accept }) =>
  new Promise<Response>((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname) !== 0 && isPrivateAddress(hostname)) {
      reject(blockedAddressError());
      return;
    }

    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(
      url,
      {
        method: 'GET',
        agent: false,
        lookup: pinnedLookup,
        signal,
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status > 599) {
          response.destroy();
          reject(new Error('Resposta inválida.'));
          return;
        }

        signal.addEventListener('abort', () => response.destroy(new Error('Tempo esgotado.')), { once: true });
        const body = NULL_BODY_STATUSES.has(status) ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>);
        if (!body) {
          response.resume();
        }
        resolve(new Response(body, { status, headers: toHeaders(response) }));
      },
    );

    request.on('error', reject);
    request.end();
  });

export async function withDeadline<T>(timeoutMs: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Tempo esgotado.')), timeoutMs);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

interface ByteStreamReader {
  read(): Promise<{ done: boolean; value: Uint8Array | undefined }>;
  cancel(): Promise<void>;
}

export async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export async function readBodyBuffer(
  response: Response,
  maxBytes: number,
  truncateOk: boolean,
  signal: AbortSignal,
): Promise<Buffer | null> {
  const reader = response.body?.getReader() as ByteStreamReader | undefined;
  if (!reader) {
    return Buffer.alloc(0);
  }

  const cancelOnAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancelOnAbort, { once: true });

  try {
    const chunks: Buffer[] = [];
    let received = 0;

    while (true) {
      if (signal.aborted) {
        throw new Error('Tempo esgotado.');
      }
      const { done, value } = await reader.read();
      if (signal.aborted) {
        throw new Error('Tempo esgotado.');
      }
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
  } finally {
    signal.removeEventListener('abort', cancelOnAbort);
  }
}
