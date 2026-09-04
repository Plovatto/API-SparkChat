import { RoomMembershipTracker, type RoomMembershipUpdate } from './room-membership-tracker.js';

export class RecordingService {
  private readonly tracker = new RoomMembershipTracker();

  startRecording(roomId: string, userId: string): string[] {
    return this.tracker.add(roomId, userId);
  }

  stopRecording(roomId: string, userId: string): string[] {
    return this.tracker.remove(roomId, userId);
  }

  removeUserEverywhere(userId: string): RoomMembershipUpdate[] {
    return this.tracker.removeUserEverywhere(userId);
  }
}
