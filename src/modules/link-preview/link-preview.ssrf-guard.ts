import dns from 'node:dns/promises';
import { isIP } from 'node:net';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return true;
  }

  const [a, b] = parts as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  return a >= 224;
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '::') {
    return true;
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }
  if (/^fe[89ab]/.test(normalized)) {
    return true;
  }

  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIPv4(mapped[1] as string) : false;
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return isPrivateIPv4(address);
  }
  if (version === 6) {
    return isPrivateIPv6(address);
  }
  return true;
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('URL inválida.');
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('Apenas URLs http/https são suportadas.');
  }

  if (parsed.port) {
    throw new Error('Portas customizadas não são suportadas.');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const literalVersion = isIP(hostname);

  if (literalVersion !== 0) {
    if (isPrivateAddress(hostname)) {
      throw new Error('Endereço não permitido.');
    }
    return parsed;
  }

  const resolved = await dns.lookup(hostname, { all: true });
  if (resolved.length === 0 || resolved.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('Endereço não permitido.');
  }

  return parsed;
}
