import type { RoomService } from '../rooms/index.js';
import type { UserService } from '../users/index.js';
import type { ScheduleTargetDirectory } from './tools/scheduled.tools.js';

export function createScheduleTargetDirectory(
  roomService: Pick<RoomService, 'getVisibleRoomsForUser' | 'isBlocked'>,
  userService: Pick<UserService, 'getUsersByIds'>,
  assistantUserId: string,
): ScheduleTargetDirectory {
  return {
    listTargets: async (userId) => {
      const rooms = (await roomService.getVisibleRoomsForUser(userId)).filter(
        (room) => room.type === 'private' && !room.participants.includes(assistantUserId) && !roomService.isBlocked(room, userId),
      );
      const otherIds = rooms.flatMap((room) => room.participants.filter((id) => id !== userId));
      const users = await userService.getUsersByIds(otherIds);
      return rooms.flatMap((room) => {
        const other = room.participants.find((id) => id !== userId);
        const nickname = other ? users.get(other)?.nickname : undefined;
        return nickname ? [{ roomId: room.id, nickname }] : [];
      });
    },
  };
}
