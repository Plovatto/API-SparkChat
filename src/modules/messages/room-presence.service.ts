import { RoomMembershipTracker } from './room-membership-tracker.js';

export class RoomPresenceService {
  private readonly tracker = new RoomMembershipTracker();

  view(roomId: string, userId: string): void {
    this.tracker.add(roomId, userId);
  }

  leave(roomId: string, userId: string): void {
    this.tracker.remove(roomId, userId);
  }

  getViewers(roomId: string): string[] {
    return this.tracker.getMembers(roomId);
  }

  removeUserEverywhere(userId: string): void {
    this.tracker.removeUserEverywhere(userId);
  }
}
