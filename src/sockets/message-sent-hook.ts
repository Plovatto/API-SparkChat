import type { AiService } from '../modules/ai/index.js';
import type { OnMessageSentHook } from '../modules/messages/message.dispatch.js';
import type { PushService } from '../modules/push/index.js';
import { ASSISTANT_USER_ID } from '../modules/users/index.js';

export function createMessageSentHook(deps: {
  aiService: Pick<AiService, 'isAssistantRoom' | 'handleIncomingMessage'>;
  pushService: Pick<PushService, 'newMessage'>;
}): OnMessageSentHook {
  return ({ io, room, message, locale }) => {
    if (message.type !== 'system' && deps.aiService.isAssistantRoom(room)) {
      void deps.aiService.handleIncomingMessage(io, room, message, locale);
    }
    if (message.type !== 'system') {
      deps.pushService.newMessage({
        roomId: room.id,
        senderId: message.senderId,
        recipientIds: room.participants.filter((id) => id !== ASSISTANT_USER_ID),
        message: { id: message.id, type: message.type, content: message.content, fileMime: message.fileMeta?.mimeType ?? null },
      });
    }
  };
}
