export interface TypingRoomUpdate {
  roomId: string;
  users: string[];
}

export class TypingService {
  private readonly typingByRoom = new Map<string, Set<string>>();

  startTyping(roomId: string, userId: string): string[] {
    const users = this.typingByRoom.get(roomId) ?? new Set<string>();
    users.add(userId);
    this.typingByRoom.set(roomId, users);
    return Array.from(users);
  }

  stopTyping(roomId: string, userId: string): string[] {
    const users = this.typingByRoom.get(roomId);
    if (!users) {
      return [];
    }

    users.delete(userId);
    return Array.from(users);
  }

  removeUserEverywhere(userId: string): TypingRoomUpdate[] {
    const updates: TypingRoomUpdate[] = [];

    for (const [roomId, users] of this.typingByRoom.entries()) {
      if (users.delete(userId)) {
        updates.push({ roomId, users: Array.from(users) });
      }
    }

    return updates;
  }
}
