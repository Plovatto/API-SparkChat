import { describe, expect, it, vi } from 'vitest';
import { systemEvent } from '@/modules/messages/index.js';
import { messageViewSchema } from '@/modules/messages/message.schemas.js';
import { buildRoomService } from './support/build-room-service.js';
import { fakeField } from './support/room-keys.js';

describe('message reactions', () => {
  it('loads the reactions of a whole page with a single query', async () => {
    const { messageService, messageRepository } = await buildRoomService();
    const sent = await Promise.all(
      ['a', 'b', 'c'].map((text) => messageService.sendMessage({ roomId: 'room-1', senderId: 'u1', content: fakeField(text) })),
    );
    await messageService.reactToMessage(sent[0]!, 'u2', fakeField('heart'));
    await messageService.reactToMessage(sent[2]!, 'u2', fakeField('laugh'));
    await messageService.reactToMessage(sent[2]!, 'u3', fakeField('heart'));
    const spy = vi.spyOn(messageRepository, 'findReactions');

    const views = await messageService.toViews(sent);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(views.map((view) => view.reactions.map((reaction) => reaction.userId))).toEqual([['u2'], [], ['u2', 'u3']]);
    for (const view of views) {
      expect(messageViewSchema.parse(view).reactions).toEqual(view.reactions);
    }
  });

  it('keeps one reaction per user, ordered by when it last changed', async () => {
    const { messageService } = await buildRoomService();
    const message = await messageService.sendMessage({ roomId: 'room-1', senderId: 'u1', content: fakeField('oi') });

    await messageService.reactToMessage(message, 'u2', fakeField('heart'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await messageService.reactToMessage(message, 'u3', fakeField('heart'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { reactions } = await messageService.reactToMessage(message, 'u2', fakeField('laugh'));

    expect(reactions.map((reaction) => [reaction.userId, reaction.emoji])).toEqual([
      ['u3', fakeField('heart')],
      ['u2', fakeField('laugh')],
    ]);

    const removed = await messageService.reactToMessage(message, 'u3', null);
    expect(removed.reactions.map((reaction) => reaction.userId)).toEqual(['u2']);
  });

  it('refuses reactions to system messages and wipes them when the message is deleted for everyone', async () => {
    const { messageService } = await buildRoomService();
    const system = await messageService.createSystemMessage('room-1', systemEvent('group.created', { actor: 'Alice' }));
    await expect(messageService.reactToMessage(system, 'u2', fakeField('heart'))).rejects.toMatchObject({ code: 'message.reactionUnavailable' });

    const message = await messageService.sendMessage({ roomId: 'room-1', senderId: 'u1', content: fakeField('oi') });
    await messageService.reactToMessage(message, 'u2', fakeField('heart'));
    await messageService.deleteMessage(message.id, 'u1');

    const deleted = (await messageService.getMessage(message.id))!;
    expect((await messageService.toView(deleted)).reactions).toEqual([]);
    expect((await messageService.toView({ ...deleted, deletedForEveryone: false })).reactions).toEqual([]);
    await expect(messageService.reactToMessage(deleted, 'u2', fakeField('heart'))).rejects.toMatchObject({ code: 'message.reactionUnavailable' });
  });
});
