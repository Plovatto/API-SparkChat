const SENSITIVE_QUERY_PREFIXES = ['/api/link-preview', '/api/gifs'];

interface LoggedRequest {
  url?: string;
  query?: unknown;
  [key: string]: unknown;
}

export function scrubRequestLog<T extends LoggedRequest>(req: T): T {
  const url = req.url;
  if (typeof url !== 'string') {
    return req;
  }

  const queryIndex = url.indexOf('?');
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
  if (!SENSITIVE_QUERY_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return req;
  }

  const { query: _query, ...rest } = req;
  return { ...rest, url: path } as T;
}
