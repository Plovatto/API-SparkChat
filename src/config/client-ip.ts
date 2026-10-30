import type { IncomingMessage } from 'node:http';
import proxyaddr from 'proxy-addr';
import { env } from './env.js';

// Same rule Express applies to req.ip with `trust proxy` set to a hop count, so HTTP routes and
// socket connections agree on who the client is.
export function getClientIp(request: IncomingMessage, trustedHops = env.TRUST_PROXY_HOPS): string {
  return proxyaddr(request, (_address, hop) => hop < trustedHops);
}
