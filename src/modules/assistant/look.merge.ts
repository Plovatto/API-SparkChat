import type { AssistantCard, AssistantLook } from './assistant.card.js';

function mergeLooks(first: AssistantLook, second: AssistantLook, firstWins: boolean): AssistantLook {
  const [low, high] = firstWins ? [second, first] : [first, second];
  const merged: AssistantLook = { ...low, ...high };
  if (low.appearance || high.appearance) {
    merged.appearance = { ...low.appearance, ...high.appearance };
  }
  return merged;
}

export function mergeAppliedCards(existing: AssistantCard | null, next: AssistantCard): AssistantCard {
  if (existing?.kind !== 'look-applied' || next.kind !== 'look-applied') {
    return next;
  }
  return {
    ...next,
    look: mergeLooks(existing.look, next.look, false),
    previous: mergeLooks(existing.previous, next.previous, true),
  };
}
