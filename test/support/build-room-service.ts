import { MessageRepository, MessageService } from '@/modules/messages/index.js';
import { RoomRepository, RoomService } from '@/modules/rooms/index.js';
import { UserRepository, UserService } from '@/modules/users/index.js';
import { createTestDb } from './create-test-db.js';

export async function buildRoomService() {
  const db = await createTestDb();

  const userRepository = new UserRepository(db);
  const userService = new UserService(userRepository);

  const messageRepository = new MessageRepository(db);
  const messageService = new MessageService(messageRepository, userService);

  const roomRepository = new RoomRepository(db);
  const roomService = new RoomService(roomRepository, userService, messageService);

  return { roomService, roomRepository, userService, userRepository, messageService, messageRepository };
}
