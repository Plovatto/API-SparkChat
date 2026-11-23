import type { CallEndReason, CallRole, CallState } from './call.types.js';

export type CallEvent =
  | { type: 'accept' }
  | { type: 'decline' }
  | { type: 'hangup'; by: CallRole }
  | { type: 'media-up' }
  | { type: 'ring-timeout' }
  | { type: 'heartbeat-timeout' }
  | { type: 'max-duration' }
  | { type: 'busy' };

export interface CallTransition {
  state: CallState;
  endReason: CallEndReason | null;
}

function ended(endReason: CallEndReason): CallTransition {
  return { state: 'ended', endReason };
}

export function peerRoleOf(role: CallRole): CallRole {
  return role === 'caller' ? 'callee' : 'caller';
}

export function isLiveState(state: CallState): boolean {
  return state === 'accepted' || state === 'active';
}

export function transition(state: CallState, event: CallEvent): CallTransition | null {
  switch (state) {
    case 'ringing':
      switch (event.type) {
        case 'accept':
          return { state: 'accepted', endReason: null };
        case 'decline':
          return ended('declined');
        case 'hangup':
          return ended(event.by === 'caller' ? 'cancelled' : 'declined');
        case 'ring-timeout':
          return ended('missed');
        case 'busy':
          return ended('busy');
        default:
          return null;
      }
    case 'accepted':
      switch (event.type) {
        case 'media-up':
          return { state: 'active', endReason: null };
        case 'hangup':
        case 'max-duration':
          return ended('completed');
        case 'heartbeat-timeout':
          return ended('connection-lost');
        default:
          return null;
      }
    case 'active':
      switch (event.type) {
        case 'hangup':
        case 'max-duration':
          return ended('completed');
        case 'heartbeat-timeout':
          return ended('connection-lost');
        default:
          return null;
      }
    case 'ended':
      return null;
  }
}
