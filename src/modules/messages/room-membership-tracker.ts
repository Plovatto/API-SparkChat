export interface RoomMembershipUpdate {
  roomId: string;
  users: string[];
}

export class RoomMembershipTracker {
  private readonly usersByRoom = new Map<string, Set<string>>();

  add(roomId: string, userId: string): string[] {
    const users = this.usersByRoom.get(roomId) ?? new Set<string>();
    users.add(userId);
    this.usersByRoom.set(roomId, users);
    return Array.from(users);
  }

  remove(roomId: string, userId: string): string[] {
    const users = this.usersByRoom.get(roomId);
    if (!users) {
      return [];
    }

    users.delete(userId);
    if (users.size === 0) {
      this.usersByRoom.delete(roomId);
    }

    return Array.from(users);
  }

  getMembers(roomId: string): string[] {
    return Array.from(this.usersByRoom.get(roomId) ?? []);
  }

  removeUserEverywhere(userId: string): RoomMembershipUpdate[] {
    const updates: RoomMembershipUpdate[] = [];

    for (const [roomId, users] of this.usersByRoom.entries()) {
      if (users.delete(userId)) {
        updates.push({ roomId, users: Array.from(users) });
        if (users.size === 0) {
          this.usersByRoom.delete(roomId);
        }
      }
    }

    return updates;
  }
}
