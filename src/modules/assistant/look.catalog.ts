import type { Locale } from '../../lib/locale.js';
import type { AssistantLook } from './assistant.card.js';
import catalogData from './look-catalog.json' with { type: 'json' };

export interface CatalogBase {
  id: string;
  name: string;
}

export interface CatalogColor {
  id: string;
  namePt: string;
  nameEn: string;
  accent: string;
  tint: string;
  gradient: string;
}

export interface CatalogWallpaper {
  id: string;
  namePt: string;
  nameEn: string;
  kind: string;
}

export type AppearanceKey = 'overlayOpacity' | 'overlayBlur' | 'ownBubbleOpacity' | 'ownTextIntensity' | 'otherBubbleOpacity' | 'otherTextIntensity' | 'bubbleBlur';

export interface LookCatalog {
  bases: CatalogBase[];
  colors: CatalogColor[];
  wallpapers: CatalogWallpaper[];
  appearanceRanges: Record<AppearanceKey, [number, number]>;
}

export type FullAppearance = Required<NonNullable<AssistantLook['appearance']>>;

export const DEFAULT_WALLPAPER_ID = 'default';

export const DEFAULT_CHAT_APPEARANCE: FullAppearance = {
  overlayOpacity: 32,
  overlayBlur: 0,
  ownBubbleColor: null,
  ownBubbleOpacity: 90,
  ownTextIntensity: null,
  otherBubbleColor: null,
  otherBubbleOpacity: 90,
  otherTextIntensity: null,
  bubbleBlur: 0,
};

const NULLABLE_NUMBER_KEYS: readonly AppearanceKey[] = ['ownTextIntensity', 'otherTextIntensity'];
const BUBBLE_COLOR_KEYS = ['ownBubbleColor', 'otherBubbleColor'] as const;
const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function loadLookCatalog(): LookCatalog {
  return catalogData as LookCatalog;
}

export function colorName(color: CatalogColor, locale: Locale): string {
  return locale === 'en' ? color.nameEn : color.namePt;
}

export function wallpaperName(wallpaper: CatalogWallpaper, locale: Locale): string {
  return locale === 'en' ? wallpaper.nameEn : wallpaper.namePt;
}

function compressIds(ids: string[]): string {
  const groups = new Map<string, number[]>();
  const plain: string[] = [];
  for (const id of ids) {
    const match = /^(.*?)(\d+)$/.exec(id);
    if (match) {
      const prefix = match[1] as string;
      groups.set(prefix, [...(groups.get(prefix) ?? []), Number(match[2])]);
    } else {
      plain.push(id);
    }
  }
  const ranges = [...groups].map(([prefix, numbers]) => `${prefix}${Math.min(...numbers)}-${Math.max(...numbers)}`);
  return [...plain, ...ranges].join(', ');
}

function wallpaperSummary(wallpapers: CatalogWallpaper[], locale: Locale): string {
  const named = wallpapers.filter((item) => item.kind === 'gradient');
  const rest = wallpapers.filter((item) => item.kind !== 'gradient');
  const namedText = named.map((item) => `${item.id} ${wallpaperName(item, locale)}`).join(', ');
  return `${namedText}, ${compressIds(rest.map((item) => item.id))}`;
}

export function catalogSummary(locale: Locale): string {
  const catalog = loadLookCatalog();
  const bases = catalog.bases.map((base) => `${base.id} ${base.name}`).join(', ');
  const colors = catalog.colors.map((color) => `${color.id} ${colorName(color, locale)} ${color.accent}`).join('; ');
  const wallpapers = wallpaperSummary(catalog.wallpapers, locale);
  const ranges = Object.entries(catalog.appearanceRanges)
    .map(([key, [min, max]]) => `${key} ${min}-${max}`)
    .join(', ');
  return locale === 'en'
    ? `Look catalog (use only these ids; numbered ranges like unsplash1-121 mean every number in the range). Base themes (id name): ${bases}. Theme colors (id name accent): ${colors}. Wallpapers: ${wallpapers}. Bubble and background adjustments, with ranges: ${ranges}; ownBubbleColor and otherBubbleColor accept hex #rrggbb or null.`
    : `Catálogo de visuais (use só estes ids; faixas numeradas como unsplash1-121 valem para todo número da faixa). Temas base (id nome): ${bases}. Cores do tema (id nome destaque): ${colors}. Papéis de parede: ${wallpapers}. Ajustes de bolha e fundo, com faixas: ${ranges}; ownBubbleColor e otherBubbleColor aceitam hex #rrggbb ou null.`;
}

function normalizeHex(value: string): string | null {
  if (!HEX_PATTERN.test(value)) {
    return null;
  }
  const digits = value.slice(1).toLowerCase();
  const expanded = digits.length === 3 ? [...digits].map((char) => char + char).join('') : digits.slice(0, 6);
  return `#${expanded}`;
}

function clampToRange(value: number, [min, max]: [number, number]): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function pickId(value: string | undefined, ids: string[], label: string, rejected: string[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (ids.includes(value)) {
    return value;
  }
  rejected.push(`${label}:${value}`);
  return undefined;
}

function sanitizeAppearance(source: NonNullable<AssistantLook['appearance']>, rejected: string[]): AssistantLook['appearance'] | undefined {
  const catalog = loadLookCatalog();
  const result: Record<string, number | string | null> = {};
  for (const key of Object.keys(catalog.appearanceRanges) as AppearanceKey[]) {
    const value = source[key];
    if (value === undefined) {
      continue;
    }
    if (value === null && NULLABLE_NUMBER_KEYS.includes(key)) {
      result[key] = null;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = clampToRange(value, catalog.appearanceRanges[key]);
    } else {
      rejected.push(`appearance.${key}`);
    }
  }
  for (const key of BUBBLE_COLOR_KEYS) {
    const value = source[key];
    if (value === undefined) {
      continue;
    }
    const hex = typeof value === 'string' ? normalizeHex(value) : null;
    if (value === null || hex) {
      result[key] = hex;
    } else {
      rejected.push(`appearance.${key}`);
    }
  }
  return Object.keys(result).length > 0 ? (result as AssistantLook['appearance']) : undefined;
}

export function sanitizeLook(look: AssistantLook): { look: AssistantLook; rejected: string[] } {
  const catalog = loadLookCatalog();
  const rejected: string[] = [];
  const result: AssistantLook = {};

  const baseTheme = pickId(look.baseTheme, catalog.bases.map((base) => base.id), 'baseTheme', rejected);
  const colorTheme = pickId(look.colorTheme, catalog.colors.map((color) => color.id), 'colorTheme', rejected);
  const wallpaper = pickId(look.wallpaper, catalog.wallpapers.map((item) => item.id), 'wallpaper', rejected);
  if (baseTheme) {
    result.baseTheme = baseTheme;
  }
  if (colorTheme) {
    result.colorTheme = colorTheme;
  }
  if (wallpaper) {
    result.wallpaper = wallpaper;
  }
  const appearance = look.appearance ? sanitizeAppearance(look.appearance, rejected) : undefined;
  if (appearance) {
    result.appearance = appearance;
  }

  return { look: result, rejected };
}

export function isLookEmpty(look: AssistantLook): boolean {
  return look.baseTheme === undefined && look.colorTheme === undefined && look.wallpaper === undefined && look.appearance === undefined;
}
