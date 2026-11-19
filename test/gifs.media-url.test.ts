import { describe, expect, it } from 'vitest';
import { isAllowedGifMediaUrl } from '@/modules/gifs/index.js';

const GOOD = 'https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/eUbp2uNc.webp';

describe('isAllowedGifMediaUrl', () => {
  it('accepts webp and gif media on the three KLIPY static hosts', () => {
    expect(isAllowedGifMediaUrl(GOOD)).toBe(true);
    expect(isAllowedGifMediaUrl(GOOD.replace('static.', 'static1.'))).toBe(true);
    expect(isAllowedGifMediaUrl(GOOD.replace('static.', 'static2.'))).toBe(true);
    expect(isAllowedGifMediaUrl(GOOD.replace('.webp', '.gif'))).toBe(true);
  });

  it.each([
    ['plain http', GOOD.replace('https://', 'http://')],
    ['another host', GOOD.replace('static.klipy.com', 'example.com')],
    ['a lookalike subdomain', GOOD.replace('static.klipy.com', 'static.klipy.com.evil.test')],
    ['a lookalike domain', GOOD.replace('static.klipy.com', 'static.klipy.co')],
    ['a nested subdomain', GOOD.replace('static.klipy.com', 'a.static.klipy.com')],
    ['an unlisted static host', GOOD.replace('static.', 'static3.')],
    ['the API host', GOOD.replace('static.', 'api.')],
    ['an uppercase host', GOOD.replace('static.klipy.com', 'STATIC.klipy.com')],
    ['an explicit port', GOOD.replace('klipy.com', 'klipy.com:443')],
    ['another port', GOOD.replace('klipy.com', 'klipy.com:8443')],
    ['user info', GOOD.replace('https://', 'https://user:pass@')],
    ['a query string', `${GOOD}?x=1`],
    ['an empty query string', `${GOOD}?`],
    ['a fragment', `${GOOD}#frag`],
    ['dot segments', 'https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/../af/eUbp2uNc.webp'],
    ['encoded dot segments', 'https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/%2e%2e/eUbp2uNc.webp'],
    ['a backslash', 'https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14\\af/eUbp2uNc.webp'],
    ['another extension', GOOD.replace('.webp', '.mp4')],
    ['a jpg', GOOD.replace('.webp', '.jpg')],
    ['an svg', GOOD.replace('.webp', '.svg')],
    ['a missing segment', 'https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/eUbp2uNc.webp'],
    ['an extra segment', 'https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/zz/eUbp2uNc.webp'],
    ['another root folder', GOOD.replace('/ii/', '/xx/')],
    ['a short hash folder', 'https://static.klipy.com/ii/abc/14/af/eUbp2uNc.webp'],
    ['a trailing slash', `${GOOD}/`],
    ['not a URL', 'not a url'],
    ['an empty string', ''],
    ['a very long URL', `https://static.klipy.com/ii/${'a'.repeat(64)}/14/af/${'b'.repeat(300)}.webp`],
  ])('rejects %s', (_label, url) => {
    expect(isAllowedGifMediaUrl(url)).toBe(false);
  });
});
