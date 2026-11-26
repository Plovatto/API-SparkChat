import type { Locale } from '../../lib/locale.js';
import type { AppServer } from '../../sockets/events.js';
import { userRoom } from '../../sockets/user-sockets.js';
import type { UserChatSettings, UserTheme } from '../users/user.model.js';
import type { UserService } from '../users/user.service.js';
import type { AssistantLook } from './assistant.card.js';
import { colorName, DEFAULT_CHAT_APPEARANCE, DEFAULT_WALLPAPER_ID, loadLookCatalog, wallpaperName, type FullAppearance } from './look.catalog.js';

const DEFAULT_THEME: UserTheme = { baseTheme: 'dark', colorTheme: 'duskViolet' };

function emptyChatSettings(): UserChatSettings {
  return { roomWallpapers: {}, globalWallpaper: null, roomAppearance: {}, globalAppearance: null };
}

export class LookService {
  constructor(private readonly userService: UserService) {}

  async currentLook(userId: string): Promise<AssistantLook> {
    const user = await this.userService.getUser(userId);
    return this.lookOf(user?.theme, user?.chatSettings);
  }

  async applyLook(io: AppServer, userId: string, look: AssistantLook): Promise<{ previous: AssistantLook }> {
    const user = await this.userService.getUser(userId);
    const previous = this.touchedPart(this.lookOf(user?.theme, user?.chatSettings), look);

    const theme = this.nextTheme(user?.theme, look);
    const settings = this.nextSettings(user?.chatSettings, look);

    if (theme) {
      await this.userService.updateTheme(userId, theme);
    }
    if (settings) {
      try {
        await this.userService.updateChatSettings(userId, settings);
      } catch (error) {
        if (theme && user?.theme) {
          await this.userService.updateTheme(userId, user.theme);
        }
        throw error;
      }
    }

    if (theme) {
      io.to(userRoom(userId)).emit('user:theme-updated', theme);
    }
    if (settings) {
      io.to(userRoom(userId)).emit('user:chat-settings-updated', { chatSettings: settings });
    }

    return { previous };
  }

  private nextTheme(current: UserTheme | undefined, look: AssistantLook): UserTheme | null {
    if (look.baseTheme === undefined && look.colorTheme === undefined) {
      return null;
    }
    const base = current ?? DEFAULT_THEME;
    return { baseTheme: look.baseTheme ?? base.baseTheme, colorTheme: look.colorTheme ?? base.colorTheme };
  }

  private nextSettings(current: UserChatSettings | null | undefined, look: AssistantLook): UserChatSettings | null {
    if (look.wallpaper === undefined && !look.appearance) {
      return null;
    }
    const settings: UserChatSettings = { ...emptyChatSettings(), ...(current ?? {}) };
    if (look.wallpaper !== undefined) {
      settings.globalWallpaper = look.wallpaper === DEFAULT_WALLPAPER_ID ? null : look.wallpaper;
    }
    if (look.appearance) {
      settings.globalAppearance = { ...DEFAULT_CHAT_APPEARANCE, ...(settings.globalAppearance ?? {}), ...look.appearance };
    }
    return settings;
  }

  private lookOf(theme: UserTheme | undefined, chatSettings: UserChatSettings | null | undefined): AssistantLook {
    const resolved = theme ?? DEFAULT_THEME;
    return {
      baseTheme: resolved.baseTheme,
      colorTheme: resolved.colorTheme,
      wallpaper: chatSettings?.globalWallpaper ?? DEFAULT_WALLPAPER_ID,
      appearance: { ...DEFAULT_CHAT_APPEARANCE, ...(chatSettings?.globalAppearance ?? {}) },
    };
  }

  private touchedPart(current: AssistantLook, look: AssistantLook): AssistantLook {
    const part: AssistantLook = {};
    if (look.baseTheme !== undefined) {
      part.baseTheme = current.baseTheme as string;
    }
    if (look.colorTheme !== undefined) {
      part.colorTheme = current.colorTheme as string;
    }
    if (look.wallpaper !== undefined) {
      part.wallpaper = current.wallpaper as string;
    }
    if (look.appearance) {
      const currentAppearance = current.appearance as FullAppearance;
      const picked: Record<string, unknown> = {};
      for (const key of Object.keys(look.appearance) as (keyof FullAppearance)[]) {
        picked[key] = currentAppearance[key];
      }
      part.appearance = picked as NonNullable<AssistantLook['appearance']>;
    }
    return part;
  }
}

const APPEARANCE_LABEL: Record<Locale, { bubbles: string; background: string }> = {
  pt: { bubbles: 'os ajustes nas bolhas', background: 'os ajustes no fundo' },
  en: { bubbles: 'bubble tweaks', background: 'background tweaks' },
};

const BACKGROUND_KEYS = ['overlayOpacity', 'overlayBlur'];

export function describeLook(look: AssistantLook, locale: Locale): string {
  const catalog = loadLookCatalog();
  const parts: string[] = [];
  const color = catalog.colors.find((item) => item.id === look.colorTheme);
  const base = catalog.bases.find((item) => item.id === look.baseTheme);
  if (color || base) {
    const name = [color ? colorName(color, locale) : null, base ? `(${base.name})` : null].filter(Boolean).join(' ');
    parts.push(`${locale === 'en' ? 'theme' : 'o tema'} ${name}`);
  }
  const wallpaper = catalog.wallpapers.find((item) => item.id === look.wallpaper);
  if (wallpaper) {
    parts.push(`${locale === 'en' ? 'wallpaper' : 'o papel de parede'} ${wallpaperName(wallpaper, locale)}`);
  }
  const keys = Object.keys(look.appearance ?? {});
  if (keys.some((key) => !BACKGROUND_KEYS.includes(key))) {
    parts.push(APPEARANCE_LABEL[locale].bubbles);
  }
  if (keys.some((key) => BACKGROUND_KEYS.includes(key))) {
    parts.push(APPEARANCE_LABEL[locale].background);
  }
  const joiner = locale === 'en' ? ' and ' : ' e ';
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')}${joiner}${parts[parts.length - 1]}` : (parts[0] ?? '');
}
