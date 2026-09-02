export class RoomPresenceService {
  private readonly viewersByRoom = new Map<string, Set<string>>();

  view(roomId: string, userId: string): void {
    const users = this.viewersByRoom.get(roomId) ?? new Set<string>();
    users.add(userId);
    this.viewersByRoom.set(roomId, users);
  }

  leave(roomId: string, userId: string): void {
    const users = this.viewersByRoom.get(roomId);
    if (!users) {
      return;
    }

    users.delete(userId);
    if (users.size === 0) {
      this.viewersByRoom.delete(roomId);
    }
  }

  getViewers(roomId: string): string[] {
    return Array.from(this.viewersByRoom.get(roomId) ?? []);
  }

  removeUserEverywhere(userId: string): void {
    for (const [roomId, users] of this.viewersByRoom.entries()) {
      if (users.delete(userId) && users.size === 0) {
        this.viewersByRoom.delete(roomId);
      }
    }
  }
}
