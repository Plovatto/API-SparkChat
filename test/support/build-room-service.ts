import { MessageRepository, MessageService } from '@/modules/messages/index.js';
import { RoomKeyRepository, RoomRepository, RoomService } from '@/modules/rooms/index.js';
import { UserRepository, UserService, UserSessionRepository } from '@/modules/users/index.js';
import { createTestDb } from './create-test-db.js';
import { TEST_RECOVERY_FILE_SECRET } from './test-constants.js';

export async function buildRoomService() {
  const db = await createTestDb();

  const userRepository = new UserRepository(db);
  const userSessionRepository = new UserSessionRepository(db);
  const userService = new UserService(userRepository, userSessionRepository, TEST_RECOVERY_FILE_SECRET);

  const messageRepository = new MessageRepository(db);
  const messageService = new MessageService(messageRepository, userService);

  const roomRepository = new RoomRepository(db);
  const roomService = new RoomService(roomRepository, userService, messageService);
  const roomKeyRepository = new RoomKeyRepository(db);

  return {
    roomService,
    roomRepository,
    roomKeyRepository,
    userService,
    userRepository,
    userSessionRepository,
    messageService,
    messageRepository,
  };
}
