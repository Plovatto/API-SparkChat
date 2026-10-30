import dns from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// IPv4 rules also match the same address written as IPv4-mapped IPv6 (::ffff:7f00:1),
// so every spelling of a private IPv4 address is caught by one list.
const BLOCKED_IPV4_SUBNETS: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
];

const BLOCKED_IPV6_SUBNETS: [string, number][] = [
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

const blockedAddresses = new BlockList();
for (const [network, prefix] of BLOCKED_IPV4_SUBNETS) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of BLOCKED_IPV6_SUBNETS) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 0) {
    return true;
  }
  return blockedAddresses.check(address, version === 4 ? 'ipv4' : 'ipv6');
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
