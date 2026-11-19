import { z } from 'zod';
import { logger } from '../../config/logger.js';
import type { IceServer } from './call.types.js';

const CLOUDFLARE_TURN_BASE_URL = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const REQUEST_TIMEOUT_MS = 5000;

export const STUN_ONLY_SERVERS: IceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478'] }];

export interface TurnCredential {
  username: string;
  iceServers: IceServer[];
}

export interface TurnProvider {
  generate(ttlSeconds: number): Promise<TurnCredential>;
  revoke(username: string): Promise<void>;
}

const urlsSchema = z.union([z.string(), z.array(z.string())]);

const iceServerSchema = z.object({
  urls: urlsSchema,
  username: z.string().optional(),
  credential: z.string().optional(),
});

const generateResponseSchema = z.object({
  iceServers: z.union([z.array(iceServerSchema), iceServerSchema.transform((single) => [single])]),
});

function usesPort53(url: string): boolean {
  return /^[a-z]+:(?:\[[^\]]*\]|[^:?/]*):53(?:[?/]|$)/i.test(url);
}

export function stripPort53(servers: IceServer[]): IceServer[] {
  return servers
    .map((server) => ({ ...server, urls: server.urls.filter((url) => !usesPort53(url)) }))
    .filter((server) => server.urls.length > 0);
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CloudflareTurnOptions {
  keyId: string;
  apiToken: string;
  fetchImpl?: FetchLike;
}

export function createCloudflareTurnProvider({ keyId, apiToken, fetchImpl = fetch }: CloudflareTurnOptions): TurnProvider {
  const keyUrl = `${CLOUDFLARE_TURN_BASE_URL}/${encodeURIComponent(keyId)}/credentials`;
  const headers = { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };

  return {
    async generate(ttlSeconds) {
      const response = await fetchImpl(`${keyUrl}/generate-ice-servers`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ttl: ttlSeconds }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        logger.warn({ status: response.status }, 'TURN credential generation failed');
        throw new Error(`TURN credential generation failed with status ${response.status}`);
      }
      const parsed = generateResponseSchema.parse(await response.json());
      const iceServers = stripPort53(
        parsed.iceServers.map((server) => ({
          urls: Array.isArray(server.urls) ? server.urls : [server.urls],
          ...(server.username ? { username: server.username } : {}),
          ...(server.credential ? { credential: server.credential } : {}),
        })),
      );
      const username = iceServers.find((server) => server.username)?.username;
      if (!username) {
        throw new Error('TURN credential response without username');
      }
      return { username, iceServers };
    },

    async revoke(username) {
      const response = await fetchImpl(`${keyUrl}/${encodeURIComponent(username)}/revoke`, {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        logger.warn({ status: response.status }, 'TURN credential revocation failed');
        throw new Error(`TURN credential revocation failed with status ${response.status}`);
      }
    },
  };
}
