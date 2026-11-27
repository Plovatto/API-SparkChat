import type { AppServer } from '../../sockets/events.js';
import type { AssistantReply } from './assistant.agent.js';

export type VaultLabel = 'assistantNote' | 'reminder' | 'scheduledMessage';

export interface AssistantHost {
  seal(userId: string, label: VaultLabel, itemId: string, plaintext: string): Promise<string | null>;
  open(userId: string, label: VaultLabel, itemId: string, sealed: string): Promise<string | null>;
  roomIdOf(userId: string): Promise<string | null>;
  post(io: AppServer, userId: string, reply: AssistantReply): Promise<void>;
}
