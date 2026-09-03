import { describe, expect, it } from 'vitest';
import { describeDevice } from '@/modules/users/user.device.js';

describe('describeDevice', () => {
  it('identifies Chrome on Windows', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
    expect(describeDevice(ua)).toBe('Chrome · Windows');
  });

  it('identifies Safari on iPhone', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
    expect(describeDevice(ua)).toBe('Safari · iPhone');
  });

  it('identifies Firefox on Linux', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0';
    expect(describeDevice(ua)).toBe('Firefox · Linux');
  });

  it('identifies Edge on Windows separately from Chrome', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
    expect(describeDevice(ua)).toBe('Edge · Windows');
  });

  it('falls back to an unknown device label for an empty user agent', () => {
    expect(describeDevice('')).toBe('Dispositivo desconhecido');
  });
});
