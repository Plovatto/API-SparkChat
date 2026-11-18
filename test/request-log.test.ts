import { describe, expect, it } from 'vitest';
import { scrubRequestLog } from '@/config/request-log.js';

describe('scrubRequestLog', () => {
  it('drops the query string of link preview requests', () => {
    const scrubbed = scrubRequestLog({
      method: 'GET',
      url: '/api/link-preview/image?url=https%3A%2F%2Fsecret.example%2Ft%3Dtoken',
      query: { url: 'x' },
    });

    expect(scrubbed).toEqual({ method: 'GET', url: '/api/link-preview/image' });
  });

  it('leaves other routes untouched', () => {
    const request = { method: 'GET', url: '/api/rooms?limit=5', query: { limit: '5' } };

    expect(scrubRequestLog(request)).toBe(request);
  });

  it('does not match routes that merely share the prefix', () => {
    const request = { url: '/api/link-previewer?x=1' };

    expect(scrubRequestLog(request)).toBe(request);
  });
});
