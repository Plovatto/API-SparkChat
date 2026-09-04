import { describe, expect, it } from 'vitest';
import { assertPublicHttpUrl } from '@/modules/link-preview/link-preview.ssrf-guard.js';

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

  it('accepts a well-formed public https URL literal', async () => {
    await expect(assertPublicHttpUrl('https://93.184.216.34/')).resolves.toBeInstanceOf(URL);
  });
});
