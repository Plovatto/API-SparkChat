import type { IncomingMessage } from 'node:http';
import proxyaddr from 'proxy-addr';
import { env } from './env.js';

export function getClientIp(request: IncomingMessage, trustedHops = env.TRUST_PROXY_HOPS): string {
  return proxyaddr(request, (_address, hop) => hop < trustedHops);
}
