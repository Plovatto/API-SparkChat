import { describe, expect, it, vi } from 'vitest';
import { catalogSummary, loadLookCatalog, sanitizeLook } from '@/modules/assistant/look.catalog.js';
import { describeLook, LookService } from '@/modules/assistant/look.service.js';
import type { AppServer } from '@/sockets/events.js';
import { buildRoomService } from './support/build-room-service.js';
import { TEST_V2_SIGNUP } from './support/test-constants.js';

const PASSWORD = 'correct-horse-battery-staple-0123456789abcd';

interface Emitted {
  room: string;
  event: string;
  payload: unknown;
}

function recordingServer(emitted: Emitted[]): AppServer {
  return {
    to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) > 0 }),
  } as unknown as AppServer;
}

describe('sanitizeLook', () => {
  it('drops unknown ids and reports them', () => {
    const { look, rejected } = sanitizeLook({ colorTheme: 'naoExiste', baseTheme: 'dark', wallpaper: 'nope' });
    expect(look).toEqual({ baseTheme: 'dark' });
    expect(rejected).toEqual(['colorTheme:naoExiste', 'wallpaper:nope']);
  });

  it('clamps sliders into the catalog range and rounds them', () => {
    const { look } = sanitizeLook({ appearance: { overlayOpacity: 400, overlayBlur: -3, ownBubbleOpacity: 55.6, ownTextIntensity: null } });
    expect(look.appearance).toEqual({ overlayOpacity: 100, overlayBlur: 0, ownBubbleOpacity: 56, ownTextIntensity: null });
  });

  it('normalizes hex colors and rejects invalid ones', () => {
    const { look, rejected } = sanitizeLook({ appearance: { ownBubbleColor: '#ABC', otherBubbleColor: 'red', bubbleBlur: Number.NaN } });
    expect(look.appearance).toEqual({ ownBubbleColor: '#aabbcc' });
    expect(rejected).toEqual(['appearance.bubbleBlur', 'appearance.otherBubbleColor']);
  });

  it('keeps valid catalog ids', () => {
    const catalog = loadLookCatalog();
    const color = catalog.colors[1]?.id as string;
    const wallpaper = catalog.wallpapers[1]?.id as string;
    expect(sanitizeLook({ colorTheme: color, wallpaper }).look).toEqual({ colorTheme: color, wallpaper });
  });
});

describe('catalogSummary', () => {
  it('lists compact id name accent entries in the user locale', () => {
    const catalog = loadLookCatalog();
    const color = catalog.colors[0];
    expect(catalogSummary('pt')).toContain(`${color?.id} ${color?.namePt} ${color?.accent}`);
    expect(catalogSummary('en')).toContain(`${color?.id} ${color?.nameEn} ${color?.accent}`);
  });
});

describe('LookService', () => {
  async function setup() {
    const services = await buildRoomService();
    const { user } = await services.userService.registerAccount({ nickname: 'Alice', avatar: 0, password: PASSWORD, ...TEST_V2_SIGNUP });
    const emitted: Emitted[] = [];
    return { ...services, user, emitted, io: recordingServer(emitted), looks: new LookService(services.userService) };
  }

  it('writes theme and global chat settings and emits both events to the user room', async () => {
    const t = await setup();
    const { previous } = await t.looks.applyLook(t.io, t.user.id, {
      baseTheme: 'midnight',
      colorTheme: 'forest',
      wallpaper: 'gradient1',
      appearance: { overlayOpacity: 60, ownBubbleColor: '#112233' },
    });
    const stored = await t.userService.getUser(t.user.id);
    expect(stored?.theme).toEqual({ baseTheme: 'midnight', colorTheme: 'forest' });
    expect(stored?.chatSettings?.globalWallpaper).toBe('gradient1');
    expect(stored?.chatSettings?.globalAppearance).toMatchObject({ overlayOpacity: 60, ownBubbleColor: '#112233', ownBubbleOpacity: 90, bubbleBlur: 0 });
    expect(t.emitted.map((entry) => [entry.room, entry.event])).toEqual([
      [`user:${t.user.id}`, 'user:theme-updated'],
      [`user:${t.user.id}`, 'user:chat-settings-updated'],
    ]);
    expect(t.emitted[0]?.payload).toEqual({ baseTheme: 'midnight', colorTheme: 'forest' });
    expect(previous).toMatchObject({ wallpaper: 'default', appearance: { overlayOpacity: 32, ownBubbleColor: null } });
  });

  it('restores exactly the previous values when applying previous', async () => {
    const t = await setup();
    await t.looks.applyLook(t.io, t.user.id, { colorTheme: 'sunset', wallpaper: 'gradient2', appearance: { overlayBlur: 4, bubbleBlur: 7 } });
    const before = await t.looks.currentLook(t.user.id);
    const { previous } = await t.looks.applyLook(t.io, t.user.id, { colorTheme: 'forest', wallpaper: 'gradient1', appearance: { overlayBlur: 15 } });
    await t.looks.applyLook(t.io, t.user.id, previous);
    expect(await t.looks.currentLook(t.user.id)).toEqual(before);
  });

  it('restores the original theme and emits nothing when the chat settings write fails', async () => {
    const t = await setup();
    await t.looks.applyLook(t.io, t.user.id, { baseTheme: 'light', colorTheme: 'sunset' });
    t.emitted.length = 0;
    vi.spyOn(t.userService, 'updateChatSettings').mockRejectedValueOnce(new Error('db down'));
    await expect(t.looks.applyLook(t.io, t.user.id, { colorTheme: 'forest', wallpaper: 'gradient1' })).rejects.toThrow('db down');
    expect((await t.userService.getUser(t.user.id))?.theme).toEqual({ baseTheme: 'light', colorTheme: 'sunset' });
    expect(t.emitted).toEqual([]);
  });

  it('clears the global wallpaper when restoring the default one', async () => {
    const t = await setup();
    const { previous } = await t.looks.applyLook(t.io, t.user.id, { wallpaper: 'gradient1' });
    await t.looks.applyLook(t.io, t.user.id, previous);
    expect((await t.userService.getUser(t.user.id))?.chatSettings?.globalWallpaper).toBeNull();
  });

  it('describes a look with catalog names in the locale', () => {
    const catalog = loadLookCatalog();
    const color = catalog.colors[0];
    expect(describeLook({ colorTheme: color?.id as string, wallpaper: 'gradient1' }, 'pt')).toBe(`o tema ${color?.namePt} e o papel de parede Oceano`);
    expect(describeLook({ colorTheme: color?.id as string, appearance: { bubbleBlur: 3 } }, 'en')).toBe(`theme ${color?.nameEn} and bubble tweaks`);
  });
});
