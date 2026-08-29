import { describe, expect, it } from 'vitest';
import { RecordingService } from '@/modules/messages/recording.service.js';

describe('RecordingService', () => {
  it('tracks who is recording per room', () => {
    const service = new RecordingService();

    expect(service.startRecording('room-1', 'alice')).toEqual(['alice']);
    expect(service.startRecording('room-1', 'bob')).toEqual(['alice', 'bob']);
    expect(service.startRecording('room-2', 'carol')).toEqual(['carol']);
  });

  it('stops tracking a user without affecting other rooms or users', () => {
    const service = new RecordingService();
    service.startRecording('room-1', 'alice');
    service.startRecording('room-1', 'bob');
    service.startRecording('room-2', 'carol');

    expect(service.stopRecording('room-1', 'alice')).toEqual(['bob']);
    expect(service.stopRecording('room-2', 'carol')).toEqual([]);
  });

  it('is a no-op when stopping a user in a room with no recording activity', () => {
    const service = new RecordingService();

    expect(service.stopRecording('unknown-room', 'alice')).toEqual([]);
  });

  it('removes a disconnected user from every room they were recording in', () => {
    const service = new RecordingService();
    service.startRecording('room-1', 'alice');
    service.startRecording('room-1', 'bob');
    service.startRecording('room-2', 'alice');
    service.startRecording('room-3', 'carol');

    const updates = service.removeUserEverywhere('alice');

    expect(updates).toEqual([
      { roomId: 'room-1', users: ['bob'] },
      { roomId: 'room-2', users: [] },
    ]);
  });
});
