import type { PixelRect } from './ocrHelpers.ts';

export const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export type RatioRect = { rx0: number; ry0: number; rx1: number; ry1: number };

export const isRatioRectEqual = (a: RatioRect, b: RatioRect): boolean =>
  Math.abs(a.rx0 - b.rx0) < 0.0001 &&
  Math.abs(a.ry0 - b.ry0) < 0.0001 &&
  Math.abs(a.rx1 - b.rx1) < 0.0001 &&
  Math.abs(a.ry1 - b.ry1) < 0.0001;

export const MASK_PRESETS: Record<string, RatioRect> = {
  name: { rx0: 0.785, ry0: 0.14, rx1: 1.0, ry1: 0.2 },
  title: { rx0: 0.785, ry0: 0.11, rx1: 1.0, ry1: 0.33 },
  full: { rx0: 0.7, ry0: 0.11, rx1: 1.0, ry1: 0.33 },
};

export const SELF_MASK_PRESETS: Record<string, RatioRect> = {
  name: { rx0: 0.269, ry0: 0.14, rx1: 0.5, ry1: 0.2 },
  title: { rx0: 0.269, ry0: 0.11, rx1: 0.5, ry1: 0.33 },
  full: { rx0: 0.185, ry0: 0.11, rx1: 0.5, ry1: 0.33 },
};

export type MaskMode = 'manual' | 'ratio' | 'ocr';
export type SortOrder = 'date_asc' | 'date_desc' | 'name_asc' | 'name_desc' | 'none';
export type OutputFormat = 'webp' | 'png' | 'jpeg';

export interface ImageSettings {
  colCount: number;
  offsetX: number;
  offsetY: number;
  sortOrder: SortOrder;
  bgColor: string;
  outputFormat: OutputFormat;
  quality: number;
  webpMethod: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  maskEnabled: boolean;
  maskX: number;
  maskY: number;
  maskWidth: number;
  maskHeight: number;
  maskColor: string;
  maskRatioRect: RatioRect;
  cropAuto: boolean;
  maskMode: MaskMode;
  selfMaskEnabled: boolean;
  selfMaskMode: MaskMode;
  selfMaskX: number;
  selfMaskY: number;
  selfMaskWidth: number;
  selfMaskHeight: number;
  selfMaskColor: string;
  selfMaskRatioRect: RatioRect;
}

export const MIN_COL_COUNT = 1;
export const MAX_COL_COUNT = 10;
export const MIN_OFFSET_PX = 0;
export const MAX_OFFSET_PX = 50;

const SIX_DIGIT_HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const THREE_DIGIT_HEX_COLOR_RE = /^#[0-9a-fA-F]{3}$/;

/** Normalizes `#rgb` or `#rrggbb` hex strings to lowercase `#rrggbb`, returning `null` when invalid. */
export const normalizeHexColor = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (SIX_DIGIT_HEX_COLOR_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (THREE_DIGIT_HEX_COLOR_RE.test(trimmed)) {
    const [, r, g, b] = trimmed.toLowerCase();
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return null;
};

export const DEFAULT_SETTINGS: ImageSettings = {
  colCount: 2,
  offsetX: 8,
  offsetY: 8,
  sortOrder: 'date_asc',
  bgColor: '#000000',
  outputFormat: 'webp',
  quality: 80,
  webpMethod: 6,
  cropX: 31,
  cropY: 117,
  cropWidth: 1538,
  cropHeight: 665,
  cropAuto: true,
  maskEnabled: false,
  maskMode: 'ratio',
  maskX: 0,
  maskY: 0,
  maskWidth: 100,
  maskHeight: 100,
  maskColor: '#ffffff',
  maskRatioRect: MASK_PRESETS.name,
  selfMaskEnabled: false,
  selfMaskMode: 'ratio',
  selfMaskX: 0,
  selfMaskY: 0,
  selfMaskWidth: 100,
  selfMaskHeight: 100,
  selfMaskColor: '#ffffff',
  selfMaskRatioRect: SELF_MASK_PRESETS.name,
};

export const createDefaultSettings = (): ImageSettings => ({
  ...DEFAULT_SETTINGS,
  maskRatioRect: { ...DEFAULT_SETTINGS.maskRatioRect },
  selfMaskRatioRect: { ...DEFAULT_SETTINGS.selfMaskRatioRect },
});

export const areSettingsDefault = (current: ImageSettings): boolean =>
  (Object.keys(DEFAULT_SETTINGS) as (keyof ImageSettings)[]).every((key) => {
    if (key === 'maskRatioRect' || key === 'selfMaskRatioRect') {
      return isRatioRectEqual(current[key], DEFAULT_SETTINGS[key]);
    }
    if (key === 'bgColor' || key === 'maskColor' || key === 'selfMaskColor') {
      const normalizedCurrent = normalizeHexColor(current[key]);
      const normalizedDefault = normalizeHexColor(DEFAULT_SETTINGS[key]);
      if (normalizedCurrent && normalizedDefault) {
        return normalizedCurrent === normalizedDefault;
      }
      return current[key].trim().toLowerCase() === DEFAULT_SETTINGS[key].toLowerCase();
    }
    return current[key] === DEFAULT_SETTINGS[key];
  });

/** Maps a detected crop rectangle `{ x, y, width, height }` onto `ImageSettings` crop fields. */
export const cropRectToSettings = (
  rect: PixelRect
): Pick<ImageSettings, 'cropX' | 'cropY' | 'cropWidth' | 'cropHeight'> => ({
  cropX: rect.x,
  cropY: rect.y,
  cropWidth: rect.width,
  cropHeight: rect.height,
});

const VALID_SORT_ORDERS: readonly SortOrder[] = ['date_asc', 'date_desc', 'name_asc', 'name_desc', 'none'];
const VALID_OUTPUT_FORMATS: readonly OutputFormat[] = ['webp', 'png', 'jpeg'];
const VALID_MASK_MODES: readonly MaskMode[] = ['manual', 'ratio', 'ocr'];

const pickEnum = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

const toBoundedInt = (value: unknown, fallback: number, min = 0, max = Number.POSITIVE_INFINITY): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;

const sanitizeHexColor = (value: unknown, fallback: string): string =>
  normalizeHexColor(value) ?? fallback;

const sanitizeRatioRect = (rect: unknown, fallback: RatioRect): RatioRect => {
  if (!rect || typeof rect !== 'object' || Array.isArray(rect)) {
    return { ...fallback };
  }
  const candidate = rect as Partial<RatioRect>;
  const rx0 = clamp01(typeof candidate.rx0 === 'number' && Number.isFinite(candidate.rx0) ? candidate.rx0 : 0);
  const ry0 = clamp01(typeof candidate.ry0 === 'number' && Number.isFinite(candidate.ry0) ? candidate.ry0 : 0);
  const rx1 = clamp01(typeof candidate.rx1 === 'number' && Number.isFinite(candidate.rx1) ? candidate.rx1 : 1);
  const ry1 = clamp01(typeof candidate.ry1 === 'number' && Number.isFinite(candidate.ry1) ? candidate.ry1 : 1);
  return {
    rx0: Math.min(rx0, rx1),
    ry0: Math.min(ry0, ry1),
    rx1: Math.max(rx0, rx1),
    ry1: Math.max(ry0, ry1),
  };
};

/**
 * Parses saved JSON settings into a clean `ImageSettings` object, migrating legacy flags
 * and stripping stale/unknown properties such as mistakenly persisted `{ x, y, width, height }`.
 */
export const parseSavedSettings = (savedSettingsJson: string | null): ImageSettings => {
  const defaults = createDefaultSettings();
  if (!savedSettingsJson) {
    return defaults;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(savedSettingsJson);
  } catch {
    return defaults;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return defaults;
  }

  const raw = parsed as Record<string, unknown>;
  const rawMaskMode = raw.maskAuto !== undefined ? (raw.maskAuto ? 'ocr' : 'manual') : raw.maskMode;
  const rawSelfMaskMode =
    raw.selfMaskAuto !== undefined ? (raw.selfMaskAuto ? 'ocr' : 'manual') : raw.selfMaskMode;
  const offsetSource = raw.offsetX !== undefined ? raw.offsetX : raw.offsetY;
  const offset = toBoundedInt(offsetSource, defaults.offsetX, MIN_OFFSET_PX, MAX_OFFSET_PX);

  return {
    colCount: toBoundedInt(raw.colCount, defaults.colCount, MIN_COL_COUNT, MAX_COL_COUNT),
    offsetX: offset,
    offsetY: offset,
    sortOrder: pickEnum(raw.sortOrder, VALID_SORT_ORDERS, defaults.sortOrder),
    bgColor: sanitizeHexColor(raw.bgColor, defaults.bgColor),
    outputFormat: pickEnum(raw.outputFormat, VALID_OUTPUT_FORMATS, defaults.outputFormat),
    quality: toBoundedInt(raw.quality, defaults.quality, 1, 100),
    webpMethod: toBoundedInt(raw.webpMethod, defaults.webpMethod, 0, 6),
    cropX: toBoundedInt(raw.cropX, defaults.cropX, 0),
    cropY: toBoundedInt(raw.cropY, defaults.cropY, 0),
    cropWidth: toBoundedInt(raw.cropWidth, defaults.cropWidth, 1),
    cropHeight: toBoundedInt(raw.cropHeight, defaults.cropHeight, 1),
    cropAuto: typeof raw.cropAuto === 'boolean' ? raw.cropAuto : defaults.cropAuto,
    maskEnabled: typeof raw.maskEnabled === 'boolean' ? raw.maskEnabled : defaults.maskEnabled,
    maskMode: pickEnum(rawMaskMode, VALID_MASK_MODES, defaults.maskMode),
    maskX: toBoundedInt(raw.maskX, defaults.maskX, 0),
    maskY: toBoundedInt(raw.maskY, defaults.maskY, 0),
    maskWidth: toBoundedInt(raw.maskWidth, defaults.maskWidth, 1),
    maskHeight: toBoundedInt(raw.maskHeight, defaults.maskHeight, 1),
    maskColor: sanitizeHexColor(raw.maskColor, defaults.maskColor),
    maskRatioRect: sanitizeRatioRect(raw.maskRatioRect, defaults.maskRatioRect),
    selfMaskEnabled: typeof raw.selfMaskEnabled === 'boolean' ? raw.selfMaskEnabled : defaults.selfMaskEnabled,
    selfMaskMode: pickEnum(rawSelfMaskMode, VALID_MASK_MODES, defaults.selfMaskMode),
    selfMaskX: toBoundedInt(raw.selfMaskX, defaults.selfMaskX, 0),
    selfMaskY: toBoundedInt(raw.selfMaskY, defaults.selfMaskY, 0),
    selfMaskWidth: toBoundedInt(raw.selfMaskWidth, defaults.selfMaskWidth, 1),
    selfMaskHeight: toBoundedInt(raw.selfMaskHeight, defaults.selfMaskHeight, 1),
    selfMaskColor: sanitizeHexColor(raw.selfMaskColor, defaults.selfMaskColor),
    selfMaskRatioRect: sanitizeRatioRect(raw.selfMaskRatioRect, defaults.selfMaskRatioRect),
  };
};
