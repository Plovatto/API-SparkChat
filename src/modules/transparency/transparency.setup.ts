import { logger } from '../../config/logger.js';
import { witnessIntervalSeconds } from '../../config/key-transparency-env.js';
import type { Database } from '../../database/turso-client.js';
import { TransparencyLog } from './transparency.log.js';
import { TransparencyRepository } from './transparency.repository.js';
import { TransparencyService, type KeyDirectory } from './transparency.service.js';
import { resolveHeadSigner, type SigningKeyEnv } from './transparency.signing-key.js';
import { buildWitnessTargets, WitnessPublisher, type WitnessEnv } from './transparency.witness.js';

export interface TransparencySetupEnv extends SigningKeyEnv, WitnessEnv {
  KEY_TRANSPARENCY_ENABLED: boolean;
  KT_WITNESS_INTERVAL_SECONDS?: string | undefined;
}

export interface TransparencySetup {
  service: TransparencyService;
  witness: WitnessPublisher;
}

export async function setupTransparency(
  env: TransparencySetupEnv,
  db: Database,
  directory: KeyDirectory,
  onKeysChangedRegistration: (listener: (userId: string) => Promise<void>) => void,
): Promise<TransparencySetup | null> {
  if (!env.KEY_TRANSPARENCY_ENABLED) {
    return null;
  }
  const repository = new TransparencyRepository(db);
  try {
    await repository.size();
  } catch (error) {
    logger.error({ err: error }, 'Key transparency is disabled: its tables are missing, run the migrations');
    return null;
  }

  const log = new TransparencyLog(repository, await resolveHeadSigner(env, repository));
  const service = new TransparencyService(log, directory);
  onKeysChangedRegistration((userId) => service.recordUser(userId));
  logger.info('Key transparency: enabled');
  service
    .backfill()
    .then((backfilled) => logger.info({ backfilled }, 'Key transparency: existing keys added to the log'))
    .catch((error: unknown) => logger.error({ err: error }, 'Key transparency: backfill failed, entries are added on demand'));

  const witness = new WitnessPublisher(buildWitnessTargets(env), () => service.head(), witnessIntervalSeconds(env.KT_WITNESS_INTERVAL_SECONDS) * 1000);
  witness.start();
  if (witness.enabled) {
    logger.info('Key transparency: witness publisher enabled');
  }
  return { service, witness };
}
