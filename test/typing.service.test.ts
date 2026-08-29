import { describe, expect, it } from 'vitest';
import { TypingService } from '@/modules/messages/typing.service.js';

describe('TypingService', () => {
  it('tracks who is typing per room', () => {
    const service = new TypingService();

    expect(service.startTyping('room-1', 'alice')).toEqual(['alice']);
    expect(service.startTyping('room-1', 'bob')).toEqual(['alice', 'bob']);
    expect(service.startTyping('room-2', 'carol')).toEqual(['carol']);
  });

  it('stops tracking a user without affecting other rooms or users', () => {
    const service = new TypingService();
    service.startTyping('room-1', 'alice');
    service.startTyping('room-1', 'bob');
    service.startTyping('room-2', 'carol');

    expect(service.stopTyping('room-1', 'alice')).toEqual(['bob']);
    expect(service.stopTyping('room-2', 'carol')).toEqual([]);
  });

  it('is a no-op when stopping a user in a room with no typing activity', () => {
    const service = new TypingService();

    expect(service.stopTyping('unknown-room', 'alice')).toEqual([]);
  });

  it('removes a disconnected user from every room they were typing in', () => {
    const service = new TypingService();
    service.startTyping('room-1', 'alice');
    service.startTyping('room-1', 'bob');
    service.startTyping('room-2', 'alice');
    service.startTyping('room-3', 'carol');

    const updates = service.removeUserEverywhere('alice');

    expect(updates).toEqual([
      { roomId: 'room-1', users: ['bob'] },
      { roomId: 'room-2', users: [] },
    ]);
  });
});
