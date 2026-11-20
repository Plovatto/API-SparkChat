import { TransparencyLog, TransparencyRepository, TransparencyService, TreeHeadSigner } from '@/modules/transparency/index.js';
import type { Database } from '@/database/turso-client.js';
import type { UserRepository, UserService } from '@/modules/users/index.js';

export function buildTransparency(db: Database, userRepository: UserRepository, userService: UserService, now: () => number = Date.now) {
  const repository = new TransparencyRepository(db);
  const signer = TreeHeadSigner.ephemeral();
  const log = new TransparencyLog(repository, signer, now);
  const service = new TransparencyService(log, {
    findKeys: async (userId) => {
      const user = await userRepository.findById(userId);
      return user?.e2ePublicKey ? { publicKey: user.e2ePublicKey, signingPublicKey: user.e2eSigningPublicKey ?? null } : null;
    },
    listKeyedUsers: (afterId, limit) => userRepository.listKeyedUsers(afterId, limit),
  });
  userService.onKeysChanged((userId) => service.recordUser(userId));
  return { repository, signer, log, service };
}
