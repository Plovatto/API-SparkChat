import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertPublicHttpUrl, isPrivateAddress } from '@/modules/link-preview/link-preview.ssrf-guard.js';

describe('assertPublicHttpUrl', () => {
  it('rejects non-http(s) protocols', async () => {
    await expect(assertPublicHttpUrl('ftp://example.com/file')).rejects.toThrow();
  });

  it('rejects URLs with an explicit port', async () => {
    await expect(assertPublicHttpUrl('http://example.com:8080/')).rejects.toThrow();
  });

  it('rejects loopback IPv4 literals', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1/')).rejects.toThrow();
  });

  it('rejects private IPv4 ranges', async () => {
    await expect(assertPublicHttpUrl('http://10.0.0.5/')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://192.168.1.1/')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://172.16.0.1/')).rejects.toThrow();
  });

  it('rejects link-local and cloud metadata addresses', async () => {
    await expect(assertPublicHttpUrl('http://169.254.169.254/')).rejects.toThrow();
  });

  it('rejects IPv6 loopback and unique-local literals', async () => {
    await expect(assertPublicHttpUrl('http://[::1]/')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://[fc00::1]/')).rejects.toThrow();
  });

  it('rejects private IPv4 addresses written as IPv6', async () => {
    await expect(assertPublicHttpUrl('http://[::ffff:127.0.0.1]/')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://[::ffff:7f00:1]/')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://[0:0:0:0:0:ffff:a9fe:a9fe]/')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://[::7f00:1]/')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://[64:ff9b::7f00:1]/')).rejects.toThrow();
  });

  it('rejects IPv4 literals in hex and short forms', async () => {
    await expect(assertPublicHttpUrl('http://0x7f.1/')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://2130706433/')).rejects.toThrow();
  });

  it('accepts a well-formed public https URL literal', async () => {
    await expect(assertPublicHttpUrl('https://93.184.216.34/')).resolves.toBeInstanceOf(URL);
    await expect(assertPublicHttpUrl('https://[::ffff:5db8:d822]/')).resolves.toBeInstanceOf(URL);
    await expect(assertPublicHttpUrl('https://[2606:4700:4700::1111]/')).resolves.toBeInstanceOf(URL);
  });
});

describe('isPrivateAddress', () => {
  const privateIPv4 = fc.oneof(
    fc.tuple(fc.constant(10), fc.nat(255), fc.nat(255), fc.nat(255)),
    fc.tuple(fc.constant(127), fc.nat(255), fc.nat(255), fc.nat(255)),
    fc.tuple(fc.constant(169), fc.constant(254), fc.nat(255), fc.nat(255)),
    fc.tuple(fc.constant(172), fc.integer({ min: 16, max: 31 }), fc.nat(255), fc.nat(255)),
    fc.tuple(fc.constant(192), fc.constant(168), fc.nat(255), fc.nat(255)),
  );

  const toMappedHex = ([a, b, c, d]: number[]) =>
    `::ffff:${(((a ?? 0) << 8) | (b ?? 0)).toString(16)}:${(((c ?? 0) << 8) | (d ?? 0)).toString(16)}`;

  it('blocks every spelling of a private IPv4 address', () => {
    fc.assert(
      fc.property(privateIPv4, (octets) => {
        const dotted = octets.join('.');
        expect(isPrivateAddress(dotted)).toBe(true);
        expect(isPrivateAddress(`::ffff:${dotted}`)).toBe(true);
        expect(isPrivateAddress(toMappedHex(octets))).toBe(true);
      }),
    );
  });

  it('treats an address and its IPv4-mapped form the same way', () => {
    fc.assert(
      fc.property(fc.ipV4(), (address) => {
        expect(isPrivateAddress(toMappedHex(address.split('.').map(Number)))).toBe(isPrivateAddress(address));
      }),
    );
  });
});
