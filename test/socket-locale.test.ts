import { describe, expect, it } from 'vitest';
import type { AppSocket } from '@/sockets/events.js';
import { resolveHandshakeLocale, socketLocale } from '@/sockets/socket-locale.js';

describe('resolveHandshakeLocale', () => {
  it.each([
    [{ locale: 'en' }, 'en'],
    [{ locale: 'pt' }, 'pt'],
    [{ locale: 'fr' }, 'pt'],
    [{ locale: 'EN' }, 'pt'],
    [{ locale: 42 }, 'pt'],
    [{}, 'pt'],
    [undefined, 'pt'],
    [null, 'pt'],
  ])('resolves %j to %s', (auth, expected) => {
    expect(resolveHandshakeLocale(auth)).toBe(expected);
  });
});

describe('socketLocale', () => {
  it('falls back to pt when the connection has no locale', () => {
    expect(socketLocale({ data: {} } as AppSocket)).toBe('pt');
  });

  it('returns the locale stored on the connection', () => {
    expect(socketLocale({ data: { locale: 'en' } } as AppSocket)).toBe('en');
  });
});
