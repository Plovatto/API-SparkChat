import { MessageRepository, MessageService } from '@/modules/messages/index.js';
import { RoomKeyRepository, RoomRepository, RoomService } from '@/modules/rooms/index.js';
import { UserRepository, UserService, UserSessionRepository } from '@/modules/users/index.js';
import { InMemoryObjectStorage } from '@/storage/object-storage.js';
import { StorageQuota } from '@/storage/storage-quota.js';
import { StorageUsageRepository } from '@/storage/storage-usage.repository.js';
import { UploadRegistry } from '@/storage/upload-registry.js';
import { createTestDb } from './create-test-db.js';
import { joinGroupWithSeededInvite } from './invites.js';
import { TEST_RECOVERY_FILE_SECRET } from './test-constants.js';

export async function buildRoomService(databaseUrl?: string) {
  const db = await createTestDb(databaseUrl);

  const userRepository = new UserRepository(db);
  const userSessionRepository = new UserSessionRepository(db);
  const userService = new UserService(userRepository, userSessionRepository, TEST_RECOVERY_FILE_SECRET);

  const objectStorage = new InMemoryObjectStorage();
  const storageUsageRepository = new StorageUsageRepository(db);
  const storageQuota = new StorageQuota(storageUsageRepository);
  const messageRepository = new MessageRepository(db);
  const uploadRegistry = new UploadRegistry(db);
  const messageService = new MessageService(messageRepository, userService, objectStorage, storageQuota, uploadRegistry);

  async function storeUpload(uploaderId: string, key: string, body: Buffer = Buffer.from('uploaded bytes')): Promise<string> {
    await objectStorage.putObject(key, body, { contentType: 'application/octet-stream' });
    await uploadRegistry.register(key, uploaderId, body.length);
    return objectStorage.publicUrl(key);
  }

  const roomRepository = new RoomRepository(db);
  const roomService = new RoomService(roomRepository, userService, messageService);
  const roomKeyRepository = new RoomKeyRepository(db);

  function joinGroup(roomId: string, userId: string) {
    return joinGroupWithSeededInvite(db, roomService, roomId, userId);
  }

  return {
    db,
    joinGroup,
    roomService,
    roomRepository,
    roomKeyRepository,
    uploadRegistry,
    storeUpload,
    userService,
    userRepository,
    userSessionRepository,
    messageService,
    messageRepository,
    objectStorage,
    storageQuota,
    storageUsageRepository,
  };
}
