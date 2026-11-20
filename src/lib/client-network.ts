import { ipKeyGenerator } from 'express-rate-limit';

const IPV6_CLIENT_SUBNET = 64;
const IPV4_MAPPED_PREFIX = '::ffff:';

export function ipKey(ip: string): string {
  const mapped = ip.toLowerCase().startsWith(IPV4_MAPPED_PREFIX) && ip.includes('.') ? ip.slice(IPV4_MAPPED_PREFIX.length) : ip;
  return ipKeyGenerator(mapped, IPV6_CLIENT_SUBNET);
}
