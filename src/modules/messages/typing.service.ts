import { RoomMembershipTracker, type RoomMembershipUpdate } from './room-membership-tracker.js';

export class TypingService {
  private readonly tracker = new RoomMembershipTracker();

  startTyping(roomId: string, userId: string): string[] {
    return this.tracker.add(roomId, userId);
  }

  stopTyping(roomId: string, userId: string): string[] {
    return this.tracker.remove(roomId, userId);
  }

  removeUserEverywhere(userId: string): RoomMembershipUpdate[] {
    return this.tracker.removeUserEverywhere(userId);
  }
}
