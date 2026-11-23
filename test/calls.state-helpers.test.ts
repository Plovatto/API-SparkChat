import { describe, expect, it } from 'vitest';
import { isLiveState, peerRoleOf } from '@/modules/calls/call.state.js';

describe('call state helpers', () => {
  it('maps each role to its peer', () => {
    expect(peerRoleOf('caller')).toBe('callee');
    expect(peerRoleOf('callee')).toBe('caller');
  });

  it('treats only accepted and active as live', () => {
    expect(isLiveState('accepted')).toBe(true);
    expect(isLiveState('active')).toBe(true);
    expect(isLiveState('ringing')).toBe(false);
    expect(isLiveState('ended')).toBe(false);
  });
});
