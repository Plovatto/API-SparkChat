import { parseSigningSeed } from '../modules/transparency/transparency.signer.js';

export interface KeyTransparencyEnvInput {
  KEY_TRANSPARENCY_ENABLED: boolean;
  KT_LOG_SIGNING_KEY?: string | undefined;
  KT_WITNESS_INTERVAL_SECONDS?: string | undefined;
  KT_WITNESS_GITHUB_REPOSITORY?: string | undefined;
  KT_WITNESS_GITHUB_PATH?: string | undefined;
  KT_WITNESS_GITHUB_BRANCH?: string | undefined;
  KT_WITNESS_GITHUB_TOKEN?: string | undefined;
  KT_WITNESS_WEBHOOK_URL?: string | undefined;
  KT_WITNESS_WEBHOOK_TOKEN?: string | undefined;
}

export interface KeyTransparencyEnvIssue {
  path: string;
  message: string;
}

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;
const BRANCH = /^[A-Za-z0-9_./-]{1,100}$/;
const DEFAULT_INTERVAL_SECONDS = 300;
const DEVELOPMENT_MODES = new Set(['development', 'test']);

export function witnessIntervalSeconds(value: string | undefined): number {
  if (value === undefined || value === '') {
    return DEFAULT_INTERVAL_SECONDS;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 30 && parsed <= 86_400 ? parsed : DEFAULT_INTERVAL_SECONDS;
}

export function validateKeyTransparencyEnv(value: KeyTransparencyEnvInput, rawNodeEnv: string | undefined): KeyTransparencyEnvIssue[] {
  if (!value.KEY_TRANSPARENCY_ENABLED) {
    return [];
  }
  const issues: KeyTransparencyEnvIssue[] = [];

  if (value.KT_LOG_SIGNING_KEY) {
    try {
      parseSigningSeed(value.KT_LOG_SIGNING_KEY);
    } catch {
      issues.push({ path: 'KT_LOG_SIGNING_KEY', message: 'KT_LOG_SIGNING_KEY must be 32 random bytes encoded as base64url (generate one with npm run kt:keygen)' });
    }
  } else if (!DEVELOPMENT_MODES.has(rawNodeEnv ?? '')) {
    issues.push({ path: 'KT_LOG_SIGNING_KEY', message: 'KT_LOG_SIGNING_KEY is required when KEY_TRANSPARENCY_ENABLED is true outside development and test (NODE_ENV must be set explicitly)' });
  }

  const interval = value.KT_WITNESS_INTERVAL_SECONDS;
  if (interval && !(Number.isInteger(Number(interval)) && Number(interval) >= 30 && Number(interval) <= 86_400)) {
    issues.push({ path: 'KT_WITNESS_INTERVAL_SECONDS', message: 'KT_WITNESS_INTERVAL_SECONDS must be an integer between 30 and 86400' });
  }
  if (value.KT_WITNESS_GITHUB_REPOSITORY && !REPOSITORY.test(value.KT_WITNESS_GITHUB_REPOSITORY)) {
    issues.push({ path: 'KT_WITNESS_GITHUB_REPOSITORY', message: 'KT_WITNESS_GITHUB_REPOSITORY must look like owner/repository' });
  }
  if (value.KT_WITNESS_GITHUB_PATH && (!PATH.test(value.KT_WITNESS_GITHUB_PATH) || value.KT_WITNESS_GITHUB_PATH.length > 200 || value.KT_WITNESS_GITHUB_PATH.split('/').includes('..'))) {
    issues.push({ path: 'KT_WITNESS_GITHUB_PATH', message: 'KT_WITNESS_GITHUB_PATH must be a relative file path without ..' });
  }
  if (value.KT_WITNESS_GITHUB_BRANCH && !BRANCH.test(value.KT_WITNESS_GITHUB_BRANCH)) {
    issues.push({ path: 'KT_WITNESS_GITHUB_BRANCH', message: 'KT_WITNESS_GITHUB_BRANCH is not a valid branch name' });
  }
  if (Boolean(value.KT_WITNESS_GITHUB_REPOSITORY) !== Boolean(value.KT_WITNESS_GITHUB_TOKEN)) {
    issues.push({ path: 'KT_WITNESS_GITHUB_TOKEN', message: 'KT_WITNESS_GITHUB_REPOSITORY and KT_WITNESS_GITHUB_TOKEN must be set together' });
  }
  if (value.KT_WITNESS_WEBHOOK_URL) {
    const https = (() => {
      try {
        return new URL(value.KT_WITNESS_WEBHOOK_URL).protocol === 'https:';
      } catch {
        return false;
      }
    })();
    if (!https) {
      issues.push({ path: 'KT_WITNESS_WEBHOOK_URL', message: 'KT_WITNESS_WEBHOOK_URL must be an https URL' });
    }
  }
  return issues;
}
