import { describe, expect, it, vi } from 'vitest';
import { budgetStep, estimateRelayBytes, FREE_TIER_BYTES } from '@/modules/calls/call-budget.js';
import { CallRateLimiter } from '@/modules/calls/call.rate-limiter.js';
import { transition, type CallEvent } from '@/modules/calls/call.state.js';
import { MAX_CALL_DURATION_MS, TURN_TTL_SECONDS } from '@/modules/calls/call.types.js';
import type { CallState } from '@/modules/calls/call.types.js';
import { createCloudflareTurnProvider, stripPort53 } from '@/modules/calls/turn-credentials.js';

describe('call state transitions', () => {
  const events: CallEvent[] = [
    { type: 'accept' },
    { type: 'decline' },
    { type: 'hangup', by: 'caller' },
    { type: 'hangup', by: 'callee' },
    { type: 'media-up' },
    { type: 'ring-timeout' },
    { type: 'heartbeat-timeout' },
    { type: 'max-duration' },
    { type: 'busy' },
  ];

  function label(event: CallEvent): string {
    return event.type === 'hangup' ? `hangup:${event.by}` : event.type;
  }

  const expected: Record<CallState, Record<string, string | null>> = {
    ringing: {
      accept: 'accepted',
      decline: 'ended:declined',
      'hangup:caller': 'ended:cancelled',
      'hangup:callee': 'ended:declined',
      'media-up': null,
      'ring-timeout': 'ended:missed',
      'heartbeat-timeout': null,
      'max-duration': null,
      busy: 'ended:busy',
    },
    accepted: {
      accept: null,
      decline: null,
      'hangup:caller': 'ended:completed',
      'hangup:callee': 'ended:completed',
      'media-up': 'active',
      'ring-timeout': null,
      'heartbeat-timeout': 'ended:connection-lost',
      'max-duration': 'ended:completed',
      busy: null,
    },
    active: {
      accept: null,
      decline: null,
      'hangup:caller': 'ended:completed',
      'hangup:callee': 'ended:completed',
      'media-up': null,
      'ring-timeout': null,
      'heartbeat-timeout': 'ended:connection-lost',
      'max-duration': 'ended:completed',
      busy: null,
    },
    ended: Object.fromEntries(events.map((event) => [label(event), null])),
  };

  for (const state of Object.keys(expected) as CallState[]) {
    for (const event of events) {
      it(`${state} + ${label(event)}`, () => {
        const result = transition(state, event);
        const text = result ? (result.endReason ? `ended:${result.endReason}` : result.state) : null;
        expect(text).toBe(expected[state][label(event)]);
      });
    }
  }
});

describe('call rate limiter', () => {
  it('limits starts per caller and per pair and recovers after a minute', () => {
    let now = 1_000_000;
    const limiter = new CallRateLimiter(() => now);

    expect(limiter.tryStart('a', 'b')).toBe(true);
    expect(limiter.tryStart('a', 'b')).toBe(true);
    expect(limiter.tryStart('a', 'b')).toBe(true);
    expect(limiter.tryStart('a', 'b')).toBe(false);
    expect(limiter.tryStart('a', 'c')).toBe(true);
    expect(limiter.tryStart('a', 'd')).toBe(true);
    expect(limiter.tryStart('a', 'e')).toBe(false);
    expect(limiter.tryStart('x', 'b')).toBe(true);

    now += 61_000;
    expect(limiter.tryStart('a', 'b')).toBe(true);
  });

  it('caps starts per pair at thirty a day', () => {
    let now = 0;
    const limiter = new CallRateLimiter(() => now);
    for (let i = 0; i < 30; i += 1) {
      expect(limiter.tryStart('a', 'b')).toBe(true);
      now += 21_000;
    }
    expect(limiter.tryStart('a', 'b')).toBe(false);
    now += 24 * 3_600_000;
    expect(limiter.tryStart('a', 'b')).toBe(true);
  });

  it('limits signals to 60 per second per call', () => {
    let now = 5000;
    const limiter = new CallRateLimiter(() => now);
    for (let i = 0; i < 60; i += 1) {
      expect(limiter.trySignal('call-1')).toBe(true);
    }
    expect(limiter.trySignal('call-1')).toBe(false);
    expect(limiter.trySignal('call-2')).toBe(true);
    now += 1000;
    expect(limiter.trySignal('call-1')).toBe(true);
  });

  it('spaces and caps ice server requests per user and call', () => {
    let now = 0;
    const limiter = new CallRateLimiter(() => now);
    expect(limiter.tryIceServers('c', 'u')).toBe(true);
    expect(limiter.tryIceServers('c', 'u')).toBe(false);
    expect(limiter.tryIceServers('c', 'v')).toBe(true);
    for (let i = 0; i < 9; i += 1) {
      now += 11_000;
      expect(limiter.tryIceServers('c', 'u')).toBe(true);
    }
    now += 11_000;
    expect(limiter.tryIceServers('c', 'u')).toBe(false);
    limiter.forgetCall('c');
    expect(limiter.tryIceServers('c', 'u')).toBe(false);
    expect(limiter.trySignal('c')).toBe(false);
    now += 61_000;
    limiter.purge();
    expect(limiter.size()).toBe(0);
  });
});

describe('call budget steps', () => {
  const tier = FREE_TIER_BYTES;

  it.each([
    [0, 'none', true],
    [0.59, 'none', true],
    [0.6, 'video-360', true],
    [0.79, 'video-360', true],
    [0.8, 'audio-only-relay', true],
    [0.94, 'audio-only-relay', true],
    [0.95, 'audio-only-relay', false],
    [1.2, 'audio-only-relay', false],
  ])('at %s of the tier', (ratio, degrade, relayAvailable) => {
    expect(budgetStep(ratio * tier, tier)).toEqual({ degrade, relayAvailable });
  });

  it('estimates the worst case from the bitrate ceiling and the credentials issued', () => {
    expect(estimateRelayBytes(3_600_000, 1)).toBe(675_000_000);
    expect(estimateRelayBytes(3_600_000, 2)).toBe(1_350_000_000);
    expect(estimateRelayBytes(3_600_000, 9)).toBe(1_350_000_000);
    expect(estimateRelayBytes(0, 2)).toBe(0);
    expect(estimateRelayBytes(1000, 0)).toBe(0);
    expect(estimateRelayBytes(-5, 1)).toBe(0);
  });
});

describe('cloudflare turn provider', () => {
  const generated = {
    iceServers: [
      {
        urls: [
          'stun:stun.cloudflare.com:3478',
          'stun:stun.cloudflare.com:53',
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turn:turn.cloudflare.com:53?transport=udp',
          'turn:turn.cloudflare.com:443?transport=tcp',
          'turns:turn.cloudflare.com:5349?transport=tcp',
          'turns:turn.cloudflare.com:53?transport=tcp',
        ],
        username: 'cf-user',
        credential: 'cf-secret',
      },
    ],
  };

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  it('requests credentials with the bearer token and ttl and drops port 53', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(generated));
    const provider = createCloudflareTurnProvider({ keyId: 'key id', apiToken: 'api-token', fetchImpl });

    const credential = await provider.generate(3_600);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key%20id/credentials/generate-ice-servers');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer api-token');
    expect(JSON.parse(init.body as string)).toEqual({ ttl: 3_600 });
    expect(credential.username).toBe('cf-user');
    expect(credential.iceServers[0]?.urls).toEqual([
      'stun:stun.cloudflare.com:3478',
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turn:turn.cloudflare.com:443?transport=tcp',
      'turns:turn.cloudflare.com:5349?transport=tcp',
    ]);
  });

  it('accepts a single object response and rejects responses without credentials', async () => {
    const single = vi.fn().mockResolvedValue(jsonResponse({ iceServers: generated.iceServers[0] }));
    expect((await createCloudflareTurnProvider({ keyId: 'k', apiToken: 't', fetchImpl: single }).generate(60)).username).toBe('cf-user');

    const bare = vi.fn().mockResolvedValue(jsonResponse({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] }));
    await expect(createCloudflareTurnProvider({ keyId: 'k', apiToken: 't', fetchImpl: bare }).generate(60)).rejects.toThrow();
  });

  it('fails on http errors without leaking the token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 500));
    const provider = createCloudflareTurnProvider({ keyId: 'k', apiToken: 'super-secret-token', fetchImpl });

    const error = await provider.generate(60).catch((err: unknown) => err as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('super-secret-token');
  });

  it('revokes a username on the revoke endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const provider = createCloudflareTurnProvider({ keyId: 'k', apiToken: 't', fetchImpl });

    await provider.revoke('user/1');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/k/credentials/user%2F1/revoke');
    expect(init.method).toBe('POST');

    fetchImpl.mockResolvedValue(jsonResponse({}, 502));
    await expect(provider.revoke('x')).rejects.toThrow();
  });

  it('keeps servers on other ports and drops empty entries', () => {
    expect(stripPort53([{ urls: ['turn:a:53'] }, { urls: ['turn:a:5349', 'turn:a:53?transport=udp'], username: 'u', credential: 'c' }])).toEqual([
      { urls: ['turn:a:5349'], username: 'u', credential: 'c' },
    ]);
    expect(stripPort53([{ urls: ['turn:a:530'] }, { urls: ['turn:a:153?transport=tcp'] }])).toHaveLength(2);
  });
});

describe('turn credential lifetime', () => {
  it('lasts one hour and the refresh cap covers a full length call', () => {
    expect(TURN_TTL_SECONDS).toBe(3_600);
    const refreshes = Math.floor(MAX_CALL_DURATION_MS / (40 * 60 * 1000));
    let now = 0;
    const limiter = new CallRateLimiter(() => now);
    expect(limiter.tryIceServers('c', 'u')).toBe(true);
    for (let i = 0; i < refreshes; i += 1) {
      now += 40 * 60 * 1000;
      expect(limiter.tryIceServers('c', 'u')).toBe(true);
    }
  });
});

describe('ice servers bypass after a transfer', () => {
  it('lets only the device that received the call skip the cooldown once', () => {
    const limiter = new CallRateLimiter(() => 1_000);
    expect(limiter.tryIceServers('c', 'u', 'old')).toBe(true);
    expect(limiter.tryIceServers('c', 'u', 'new')).toBe(false);
    limiter.allowNextIceServers('c', 'u', 'new');
    expect(limiter.tryIceServers('c', 'u', 'old')).toBe(false);
    expect(limiter.tryIceServers('c', 'u', 'new')).toBe(true);
    expect(limiter.tryIceServers('c', 'u', 'new')).toBe(false);
  });
});
