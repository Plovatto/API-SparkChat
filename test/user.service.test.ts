import { describe, expect, it } from 'vitest';
import { buildRoomService } from './support/build-room-service.js';

describe('UserService', () => {
  it('updates the nickname and avatar of an existing user', async () => {
    const { userService } = await buildRoomService();
    const user = await userService.joinOrCreate({ nickname: 'Alice', avatar: 0, socketId: 'socket-alice' });

    const updated = await userService.updateProfile(user.id, { nickname: 'Alicia', avatar: 3 });

    expect(updated?.nickname).toBe('Alicia');
    expect(updated?.avatar).toBe(3);
    expect(updated?.chatCode).toBe(user.chatCode);
    expect(updated?.loginCode).toBe(user.loginCode);
  });

  it('returns null when updating the profile of an unknown user', async () => {
    const { userService } = await buildRoomService();

    const updated = await userService.updateProfile('unknown-id', { nickname: 'Ghost', avatar: 0 });

    expect(updated).toBeNull();
  });

  it('persists a user theme choice', async () => {
    const { userService } = await buildRoomService();
    const user = await userService.joinOrCreate({ nickname: 'Alice', avatar: 0, socketId: 'socket-alice' });

    const updated = await userService.updateTheme(user.id, { baseTheme: 'light', colorTheme: 'ocean' });

    expect(updated?.theme).toEqual({ baseTheme: 'light', colorTheme: 'ocean' });
    expect((await userService.getUser(user.id))?.theme).toEqual({ baseTheme: 'light', colorTheme: 'ocean' });
  });

  it('returns null when updating the theme of an unknown user', async () => {
    const { userService } = await buildRoomService();

    const updated = await userService.updateTheme('unknown-id', { baseTheme: 'light', colorTheme: 'ocean' });

    expect(updated).toBeNull();
  });
});
