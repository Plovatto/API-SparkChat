export interface RecordingRoomUpdate {
  roomId: string;
  users: string[];
}

export class RecordingService {
  private readonly recordingByRoom = new Map<string, Set<string>>();

  startRecording(roomId: string, userId: string): string[] {
    const users = this.recordingByRoom.get(roomId) ?? new Set<string>();
    users.add(userId);
    this.recordingByRoom.set(roomId, users);
    return Array.from(users);
  }

  stopRecording(roomId: string, userId: string): string[] {
    const users = this.recordingByRoom.get(roomId);
    if (!users) {
      return [];
    }

    users.delete(userId);
    return Array.from(users);
  }

  removeUserEverywhere(userId: string): RecordingRoomUpdate[] {
    const updates: RecordingRoomUpdate[] = [];

    for (const [roomId, users] of this.recordingByRoom.entries()) {
      if (users.delete(userId)) {
        updates.push({ roomId, users: Array.from(users) });
      }
    }

    return updates;
  }
}
