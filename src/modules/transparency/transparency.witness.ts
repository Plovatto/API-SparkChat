import { logger } from '../../config/logger.js';
import type { SignedTreeHead } from './transparency.signer.js';

export interface WitnessTarget {
  describe(): string;
  publish(body: string): Promise<void>;
}

export interface GithubWitnessOptions {
  repository: string;
  path: string;
  branch: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface WebhookWitnessOptions {
  url: string;
  token?: string | undefined;
  fetchImpl?: typeof fetch;
}

const REQUEST_TIMEOUT_MS = 10_000;

export function witnessBody(head: SignedTreeHead): string {
  return `${JSON.stringify({ v: 1, size: head.size, root: head.root, issuedAt: head.issuedAt, signature: head.signature })}\n`;
}

export class GithubWitnessTarget implements WitnessTarget {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GithubWitnessOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  describe(): string {
    return `github:${this.options.repository}/${this.options.path}@${this.options.branch}`;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'sparkchat-key-transparency',
    };
  }

  private url(): string {
    const encodedPath = this.options.path.split('/').map(encodeURIComponent).join('/');
    return `https://api.github.com/repos/${this.options.repository}/contents/${encodedPath}`;
  }

  async publish(body: string): Promise<void> {
    const lookup = await this.fetchImpl(`${this.url()}?ref=${encodeURIComponent(this.options.branch)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let sha: string | undefined;
    if (lookup.status === 200) {
      const existing = (await lookup.json()) as { sha?: unknown };
      sha = typeof existing.sha === 'string' ? existing.sha : undefined;
    } else if (lookup.status !== 404) {
      throw new Error(`GitHub witness lookup failed with status ${lookup.status}`);
    }
    const response = await this.fetchImpl(this.url(), {
      method: 'PUT',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Update signed tree head',
        content: Buffer.from(body, 'utf8').toString('base64'),
        branch: this.options.branch,
        ...(sha ? { sha } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`GitHub witness publish failed with status ${response.status}`);
    }
  }
}

export class WebhookWitnessTarget implements WitnessTarget {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: WebhookWitnessOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  describe(): string {
    return `webhook:${new URL(this.options.url).host}`;
  }

  async publish(body: string): Promise<void> {
    const response = await this.fetchImpl(this.options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}) },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Webhook witness publish failed with status ${response.status}`);
    }
  }
}

export interface WitnessEnv {
  KT_WITNESS_GITHUB_REPOSITORY?: string | undefined;
  KT_WITNESS_GITHUB_PATH?: string | undefined;
  KT_WITNESS_GITHUB_BRANCH?: string | undefined;
  KT_WITNESS_GITHUB_TOKEN?: string | undefined;
  KT_WITNESS_WEBHOOK_URL?: string | undefined;
  KT_WITNESS_WEBHOOK_TOKEN?: string | undefined;
}

export function buildWitnessTargets(env: WitnessEnv): WitnessTarget[] {
  const targets: WitnessTarget[] = [];
  if (env.KT_WITNESS_GITHUB_REPOSITORY && env.KT_WITNESS_GITHUB_TOKEN) {
    targets.push(
      new GithubWitnessTarget({
        repository: env.KT_WITNESS_GITHUB_REPOSITORY,
        path: env.KT_WITNESS_GITHUB_PATH ?? 'head.json',
        branch: env.KT_WITNESS_GITHUB_BRANCH ?? 'main',
        token: env.KT_WITNESS_GITHUB_TOKEN,
      }),
    );
  }
  if (env.KT_WITNESS_WEBHOOK_URL) {
    targets.push(new WebhookWitnessTarget({ url: env.KT_WITNESS_WEBHOOK_URL, token: env.KT_WITNESS_WEBHOOK_TOKEN }));
  }
  return targets;
}

export class WitnessPublisher {
  private lastPublishedSize = -1;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly targets: WitnessTarget[],
    private readonly currentHead: () => Promise<SignedTreeHead>,
    private readonly intervalMs: number,
  ) {}

  get enabled(): boolean {
    return this.targets.length > 0;
  }

  start(): void {
    if (!this.enabled || this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<boolean> {
    if (this.running || !this.enabled) {
      return false;
    }
    this.running = true;
    try {
      const head = await this.currentHead();
      if (head.size === 0 || head.size === this.lastPublishedSize) {
        return false;
      }
      const body = witnessBody(head);
      const results = await Promise.allSettled(this.targets.map((target) => target.publish(body)));
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.warn(
            { target: (this.targets[index] as WitnessTarget).describe(), reason: result.reason instanceof Error ? result.reason.message : 'unknown' },
            'Key transparency witness publish failed',
          );
        }
      });
      const delivered = results.every((result) => result.status === 'fulfilled');
      if (delivered) {
        this.lastPublishedSize = head.size;
      }
      return delivered;
    } catch (error) {
      logger.warn({ err: error }, 'Key transparency witness tick failed');
      return false;
    } finally {
      this.running = false;
    }
  }
}
