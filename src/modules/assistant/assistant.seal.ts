import { sealField } from '../ai/ai.crypto.js';
import type { AssistantCard } from './assistant.card.js';

export const ASSISTANT_CARD_LABEL = 'assistantCard';

export interface AssistantRoomKey {
  keyId: string;
  roomKey: Uint8Array;
}

export function sealAssistantCard(
  card: AssistantCard,
  roomKey: AssistantRoomKey,
  roomId: string,
  messageId: string,
  signingPrivateKey: Uint8Array,
  senderId: string,
): Promise<string> {
  return sealField(JSON.stringify(card), roomKey.roomKey, roomKey.keyId, signingPrivateKey, {
    roomId,
    senderId,
    messageId,
    label: ASSISTANT_CARD_LABEL,
  });
}
