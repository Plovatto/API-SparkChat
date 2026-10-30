import type { IncomingMessage } from 'node:http';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { getClientIp } from '@/config/client-ip.js';

function buildRequest(remoteAddress: string, forwardedFor?: string): IncomingMessage {
  return {
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    socket: { remoteAddress },
    connection: { remoteAddress },
  } as unknown as IncomingMessage;
}

describe('getClientIp', () => {
  it('ignores X-Forwarded-For when no proxy is trusted', () => {
    expect(getClientIp(buildRequest('203.0.113.7', '198.51.100.1'), 0)).toBe('203.0.113.7');
  });

  it('uses the address added by the trusted proxy', () => {
    expect(getClientIp(buildRequest('10.0.0.2', '198.51.100.1'), 1)).toBe('198.51.100.1');
  });

  it('does not let the client choose its own address through extra X-Forwarded-For entries', () => {
    fc.assert(
      fc.property(fc.array(fc.ipV4(), { maxLength: 5 }), fc.ipV4(), (spoofed, real) => {
        const forwardedFor = [...spoofed, real].join(', ');
        expect(getClientIp(buildRequest('10.0.0.2', forwardedFor), 1)).toBe(real);
      }),
    );
  });
});
