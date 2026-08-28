import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { JsonFileStore } from '@/database/json-file-store.js';
import { RoomRepository, RoomService, type RoomRecord } from '@/modules/rooms/index.js';
import { UserRepository, UserService, type UserRecord } from '@/modules/users/index.js';

export function buildRoomService() {
  const usersFile = path.join(os.tmpdir(), `sparkchat-test-users-${randomUUID()}.json`);
  const roomsFile = path.join(os.tmpdir(), `sparkchat-test-rooms-${randomUUID()}.json`);

  const userRepository = new UserRepository(new JsonFileStore<UserRecord>(usersFile));
  const userService = new UserService(userRepository);

  const roomRepository = new RoomRepository(new JsonFileStore<RoomRecord>(roomsFile));
  const roomService = new RoomService(roomRepository, userService);

  return { roomService, roomRepository, userService, userRepository };
}
