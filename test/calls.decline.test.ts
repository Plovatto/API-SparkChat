import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { CallDeclineTokens } from '@/modules/calls/call-decline-token.js';
import { createCallRouter } from '@/modules/calls/call.routes.js';
import { errorHandler } from '@/middleware/errorHandler.js';
import { AppError } from '@/lib/app-error.js';

describe('call decline tokens', () => {
  it('binds a token to the user, the call and its expiry', () => {
    let now = 1_000_000;
    const tokens = new CallDeclineTokens({ now: () => now });
    const token = tokens.issue('user-1', 'call-1', now + 45_000);

    expect(tokens.verify(token, 'call-1')).toEqual({ userId: 'user-1' });
    expect(tokens.verify(token, 'call-2')).toBeNull();
    now += 45_001;
    expect(tokens.verify(token, 'call-1')).toBeNull();
  });

  it('rejects tampered, foreign and malformed tokens', () => {
    const now = 1_000_000;
    const tokens = new CallDeclineTokens({ now: () => now });
    const other = new CallDeclineTokens({ now: () => now });
    const token = tokens.issue('user-1', 'call-1', now + 45_000);
    const [user, expiry, mac] = token.split('.');
    const forgedUser = Buffer.from('user-2').toString('base64url');

    expect(other.verify(token, 'call-1')).toBeNull();
    expect(tokens.verify(`${forgedUser}.${expiry}.${mac}`, 'call-1')).toBeNull();
    expect(tokens.verify(`${user}.${Number(expiry) + 1000}.${mac}`, 'call-1')).toBeNull();
    expect(tokens.verify('', 'call-1')).toBeNull();
    expect(tokens.verify('a.b', 'call-1')).toBeNull();
    expect(tokens.verify(`${user}.${expiry}.${mac}x`, 'call-1')).toBeNull();
  });
});

function appWith(decline: (input: { callId: string; token: string }) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use('/api/calls', createCallRouter(decline));
  app.use(errorHandler);
  return app;
}

describe('call decline route', () => {
  it('declines with the call id and token and answers 204', async () => {
    const decline = vi.fn(() => Promise.resolve());
    const response = await request(appWith(decline)).post('/api/calls/decline').send({ callId: 'call-1', token: 'tok' });

    expect(response.status).toBe(204);
    expect(decline).toHaveBeenCalledWith({ callId: 'call-1', token: 'tok' });
  });

  it('rejects an invalid body without calling the service', async () => {
    const decline = vi.fn(() => Promise.resolve());
    const response = await request(appWith(decline)).post('/api/calls/decline').send({ callId: 'call-1' });

    expect(response.status).toBe(400);
    expect(decline).not.toHaveBeenCalled();
  });

  it('answers 204 when the call already stopped ringing so a retried decline is harmless', async () => {
    const decline = vi.fn(() => Promise.reject(AppError.of('call.invalidState')));
    const response = await request(appWith(decline)).post('/api/calls/decline').send({ callId: 'call-1', token: 'tok' });

    expect(response.status).toBe(204);
  });

  it('maps a refused token to the service error', async () => {
    const decline = vi.fn(() => Promise.reject(AppError.of('call.notAllowed')));
    const response = await request(appWith(decline)).post('/api/calls/decline').send({ callId: 'call-1', token: 'bad' });

    expect(response.status).toBe(403);
  });
});
