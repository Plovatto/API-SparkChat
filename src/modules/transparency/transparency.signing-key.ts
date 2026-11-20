import { generateSigningSeed, parseSigningSeed, TreeHeadSigner } from './transparency.signer.js';
import type { TransparencyRepository } from './transparency.repository.js';

const DEV_SEED_META_KEY = 'dev_signing_seed';

export interface SigningKeyEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  KT_LOG_SIGNING_KEY?: string | undefined;
}

export async function resolveHeadSigner(env: SigningKeyEnv, repository: TransparencyRepository): Promise<TreeHeadSigner> {
  if (env.KT_LOG_SIGNING_KEY) {
    return new TreeHeadSigner(parseSigningSeed(env.KT_LOG_SIGNING_KEY));
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('KT_LOG_SIGNING_KEY is required when KEY_TRANSPARENCY_ENABLED is true in production.');
  }
  if (env.NODE_ENV === 'test') {
    return TreeHeadSigner.ephemeral();
  }
  await repository.setMetaIfAbsent(DEV_SEED_META_KEY, generateSigningSeed());
  const stored = await repository.getMeta(DEV_SEED_META_KEY);
  if (!stored) {
    throw new Error('Could not persist the development log signing key.');
  }
  return new TreeHeadSigner(parseSigningSeed(stored));
}
