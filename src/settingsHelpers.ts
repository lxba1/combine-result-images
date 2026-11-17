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

export const cloneSettings = (settings: ImageSettings): ImageSettings => ({
  ...settings,
  maskRatioRect: { ...settings.maskRatioRect },
  selfMaskRatioRect: { ...settings.selfMaskRatioRect },
});

export const createDefaultSettings = (): ImageSettings => cloneSettings(DEFAULT_SETTINGS);

const CROP_COORD_KEYS = new Set<keyof ImageSettings>([
  'cropX',
  'cropY',
  'cropWidth',
  'cropHeight',
]);
const MASK_COORD_KEYS = new Set<keyof ImageSettings>([
  'maskX',
  'maskY',
  'maskWidth',
  'maskHeight',
]);
const SELF_MASK_COORD_KEYS = new Set<keyof ImageSettings>([
  'selfMaskX',
  'selfMaskY',
  'selfMaskWidth',
  'selfMaskHeight',
]);

const isAutoManagedPixelCoordKey = (
  key: keyof ImageSettings,
  current: ImageSettings
): boolean => {
  if (current.cropAuto && CROP_COORD_KEYS.has(key)) {
    return true;
  }
  if ((!current.maskEnabled || current.maskMode !== 'manual') && MASK_COORD_KEYS.has(key)) {
    return true;
  }
  if (
    (!current.selfMaskEnabled || current.selfMaskMode !== 'manual') &&
    SELF_MASK_COORD_KEYS.has(key)
  ) {
    return true;
  }
  return false;
};

/**
 * Compares two `ImageSettings` objects while ignoring pixel coordinates that are auto-computed
 * at runtime (`crop*` when auto-crop is enabled, and `mask*`/`selfMask*` when disabled or
 * in `'ratio'`/`'ocr'` mode).
 */
export const areSettingsEqual = (a: ImageSettings, b: ImageSettings): boolean =>
  (Object.keys(DEFAULT_SETTINGS) as (keyof ImageSettings)[]).every((key) => {
    if (isAutoManagedPixelCoordKey(key, a) && isAutoManagedPixelCoordKey(key, b)) {
      return true;
    }
    if (key === 'maskRatioRect' || key === 'selfMaskRatioRect') {
      return isRatioRectEqual(a[key], b[key]);
    }
    if (key === 'bgColor' || key === 'maskColor' || key === 'selfMaskColor') {
      const normalizedA = normalizeHexColor(a[key]);
      const normalizedB = normalizeHexColor(b[key]);
      if (normalizedA && normalizedB) {
        return normalizedA === normalizedB;
      }
      return a[key].trim().toLowerCase() === b[key].trim().toLowerCase();
    }
    return a[key] === b[key];
  });

/**
 * Returns whether user-facing settings match `DEFAULT_SETTINGS`, ignoring runtime auto coordinates.
 */
export const areSettingsDefault = (current: ImageSettings): boolean =>
  areSettingsEqual(current, DEFAULT_SETTINGS);

export type ResultStaleReason = 'none' | 'settings' | 'images' | 'both';

/**
 * Determines whether an existing processed result is stale relative to the current
 * settings and selected image list.
 */
export const getResultStaleReason = <T>(params: {
  currentSettings: ImageSettings;
  snapshotSettings: ImageSettings;
  currentImages: readonly T[];
  snapshotImages: readonly T[];
}): ResultStaleReason => {
  const settingsChanged = !areSettingsEqual(params.currentSettings, params.snapshotSettings);
  const imagesChanged =
    params.currentImages.length !== params.snapshotImages.length ||
    params.currentImages.some((item, index) => item !== params.snapshotImages[index]);
  if (settingsChanged && imagesChanged) return 'both';
  if (settingsChanged) return 'settings';
  if (imagesChanged) return 'images';
  return 'none';
};

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

/** Clamps a ratio rectangle to [0, 1] and orders endpoints so rx0 <= rx1 and ry0 <= ry1. */
export const normalizeRatioRect = (rect: RatioRect): RatioRect => ({
  rx0: clamp01(Math.min(rect.rx0, rect.rx1)),
  ry0: clamp01(Math.min(rect.ry0, rect.ry1)),
  rx1: clamp01(Math.max(rect.rx0, rect.rx1)),
  ry1: clamp01(Math.max(rect.ry0, rect.ry1)),
});

const sanitizeRatioRect = (rect: unknown, fallback: RatioRect): RatioRect => {
  if (!rect || typeof rect !== 'object' || Array.isArray(rect)) {
    return { ...fallback };
  }
  const candidate = rect as Partial<RatioRect>;
  return normalizeRatioRect({
    rx0: typeof candidate.rx0 === 'number' && Number.isFinite(candidate.rx0) ? candidate.rx0 : 0,
    ry0: typeof candidate.ry0 === 'number' && Number.isFinite(candidate.ry0) ? candidate.ry0 : 0,
    rx1: typeof candidate.rx1 === 'number' && Number.isFinite(candidate.rx1) ? candidate.rx1 : 1,
    ry1: typeof candidate.ry1 === 'number' && Number.isFinite(candidate.ry1) ? candidate.ry1 : 1,
  });
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

export const MAX_RECOMMENDED_CANVAS_SIDE = 32_767;
export const MAX_RECOMMENDED_CANVAS_PIXELS = 268_435_456;
export const MAX_WEBP_DIMENSION = 16_383;

export interface MontageSizeEvaluation {
  width: number;
  height: number;
  pixels: number;
  status: 'ok' | 'invalid' | 'confirm_required';
  reason?: 'non_positive_or_overflow' | 'exceeds_canvas_limits' | 'exceeds_webp_dimension';
}

/**
 * Evaluates output montage canvas dimensions before allocation.
 * Blocks mathematically invalid dimensions as well as WebP outputs exceeding `MAX_WEBP_DIMENSION`
 * (since WebP has a 16,383 px format limit and Chrome silently truncates larger WebP exports),
 * while requesting user confirmation for oversized PNG/JPEG dimensions above canvas ceilings.
 */
export const evaluateMontageCanvasSize = (
  imageCount: number,
  cropRect: Pick<PixelRect, 'width' | 'height'>,
  settings: Pick<ImageSettings, 'colCount' | 'offsetX' | 'offsetY' | 'outputFormat'>
): MontageSizeEvaluation => {
  if (
    !Number.isSafeInteger(imageCount) ||
    imageCount <= 0 ||
    !Number.isSafeInteger(settings.colCount) ||
    settings.colCount <= 0 ||
    !Number.isSafeInteger(cropRect.width) ||
    cropRect.width <= 0 ||
    !Number.isSafeInteger(cropRect.height) ||
    cropRect.height <= 0 ||
    !Number.isSafeInteger(settings.offsetX) ||
    settings.offsetX < 0 ||
    !Number.isSafeInteger(settings.offsetY) ||
    settings.offsetY < 0
  ) {
    return {
      width: 0,
      height: 0,
      pixels: 0,
      status: 'invalid',
      reason: 'non_positive_or_overflow',
    };
  }

  const rows = Math.ceil(imageCount / settings.colCount);
  const width = cropRect.width * settings.colCount + settings.offsetX * (settings.colCount + 1);
  const height = rows * cropRect.height + settings.offsetY * (rows + 1);
  const pixels = width * height;

  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(pixels) ||
    width <= 0 ||
    height <= 0
  ) {
    return {
      width: Number.isFinite(width) ? Math.round(width) : 0,
      height: Number.isFinite(height) ? Math.round(height) : 0,
      pixels: 0,
      status: 'invalid',
      reason: 'non_positive_or_overflow',
    };
  }

  if (
    settings.outputFormat === 'webp' &&
    (width > MAX_WEBP_DIMENSION || height > MAX_WEBP_DIMENSION)
  ) {
    return {
      width,
      height,
      pixels,
      status: 'invalid',
      reason: 'exceeds_webp_dimension',
    };
  }

  if (
    width > MAX_RECOMMENDED_CANVAS_SIDE ||
    height > MAX_RECOMMENDED_CANVAS_SIDE ||
    pixels > MAX_RECOMMENDED_CANVAS_PIXELS
  ) {
    return {
      width,
      height,
      pixels,
      status: 'confirm_required',
      reason: 'exceeds_canvas_limits',
    };
  }

  return { width, height, pixels, status: 'ok' };
};

export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export const SETTINGS_STORAGE_KEY = 'imageProcessorSettings';

const resolveDefaultStorage = (): StorageLike | null => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
};

/**
 * Loads and sanitizes persisted settings from Web Storage, returning defaults
 * if storage access is denied (e.g., SecurityError) or unavailable.
 */
export const loadSettingsFromStorage = (
  getStorage: () => StorageLike | null = resolveDefaultStorage,
  key: string = SETTINGS_STORAGE_KEY
): ImageSettings => {
  try {
    const storage = getStorage();
    return parseSavedSettings(storage ? storage.getItem(key) : null);
  } catch (error) {
    console.warn('Failed to load settings from localStorage:', error);
    return createDefaultSettings();
  }
};

/**
 * Persists settings to Web Storage, returning `false` without throwing
 * when storage access is denied or quota is exceeded.
 */
export const saveSettingsToStorage = (
  settings: ImageSettings,
  getStorage: () => StorageLike | null = resolveDefaultStorage,
  key: string = SETTINGS_STORAGE_KEY
): boolean => {
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.setItem(key, JSON.stringify(settings));
    return true;
  } catch (error) {
    console.warn('Failed to persist settings to localStorage:', error);
    return false;
  }
};

export type MaskTarget = 'mask' | 'selfMask';
export type SettingsAccordionId = 'settings' | 'crop' | MaskTarget;

export interface ErrorUiTarget {
  accordions: SettingsAccordionId[];
  fields: SettingFieldKey[];
}

export type SettingFieldKey =
  | 'colCount'
  | 'offsetX'
  | 'bgColor'
  | 'outputFormat'
  | 'cropX'
  | 'cropY'
  | 'cropWidth'
  | 'cropHeight'
  | 'maskMode'
  | 'maskColor'
  | 'maskX'
  | 'maskY'
  | 'maskWidth'
  | 'maskHeight'
  | 'maskRatioRect.rx0'
  | 'maskRatioRect.ry0'
  | 'maskRatioRect.rx1'
  | 'maskRatioRect.ry1'
  | 'selfMaskMode'
  | 'selfMaskColor'
  | 'selfMaskX'
  | 'selfMaskY'
  | 'selfMaskWidth'
  | 'selfMaskHeight'
  | 'selfMaskRatioRect.rx0'
  | 'selfMaskRatioRect.ry0'
  | 'selfMaskRatioRect.rx1'
  | 'selfMaskRatioRect.ry1';

export type FieldTuple4 = readonly [
  SettingFieldKey,
  SettingFieldKey,
  SettingFieldKey,
  SettingFieldKey,
];

export const CROP_FIELD_KEYS: FieldTuple4 = ['cropX', 'cropY', 'cropWidth', 'cropHeight'];

export const getMaskCoordFieldKeys = (target: MaskTarget): FieldTuple4 =>
  target === 'mask'
    ? ['maskX', 'maskY', 'maskWidth', 'maskHeight']
    : ['selfMaskX', 'selfMaskY', 'selfMaskWidth', 'selfMaskHeight'];

export const getMaskRatioFieldKeys = (target: MaskTarget): FieldTuple4 =>
  target === 'mask'
    ? ['maskRatioRect.rx0', 'maskRatioRect.ry0', 'maskRatioRect.rx1', 'maskRatioRect.ry1']
    : [
        'selfMaskRatioRect.rx0',
        'selfMaskRatioRect.ry0',
        'selfMaskRatioRect.rx1',
        'selfMaskRatioRect.ry1',
      ];

export type SettingsValidationResult =
  | { valid: true }
  | {
      valid: false;
      alertKey:
        | 'alert_columns_must_be_positive'
        | 'alert_offset_cannot_be_empty_or_negative'
        | 'alert_invalid_crop_setting'
        | 'alert_invalid_mask_area'
        | 'alert_invalid_color_setting';
      accordion: SettingsAccordionId;
      fields: SettingFieldKey[];
    };

const getOrderedClampedRatio = (rect: RatioRect): RatioRect | null => {
  if (
    !Number.isFinite(rect.rx0) ||
    !Number.isFinite(rect.ry0) ||
    !Number.isFinite(rect.rx1) ||
    !Number.isFinite(rect.ry1)
  ) {
    return null;
  }
  return normalizeRatioRect(rect);
};

/**
 * Applies a ratio mask field update and swaps inverted endpoints when `finalize` is true
 * so entering Left > Right or Top > Bottom preserves the span instead of collapsing to 0.
 */
export const commitRatioRectField = (
  rect: RatioRect,
  key: keyof RatioRect,
  value: number,
  options?: { finalize?: boolean }
): RatioRect => {
  if (!Number.isFinite(value)) {
    return options?.finalize ? (getOrderedClampedRatio(rect) ?? { ...rect }) : { ...rect };
  }
  const nextRect: RatioRect = { ...rect, [key]: clamp01(value) };
  if (!options?.finalize) {
    return nextRect;
  }
  return getOrderedClampedRatio(nextRect) ?? nextRect;
};

const isSafeIntInRange = (value: number, min: number, max: number): boolean =>
  Number.isSafeInteger(value) && value >= min && value <= max;

const getInvalidPixelRectFields = (
  rect: { x: number; y: number; width: number; height: number },
  fieldKeys: FieldTuple4
): SettingFieldKey[] => {
  const invalid: SettingFieldKey[] = [];
  if (!Number.isSafeInteger(rect.x) || rect.x < 0) invalid.push(fieldKeys[0]);
  if (!Number.isSafeInteger(rect.y) || rect.y < 0) invalid.push(fieldKeys[1]);
  if (!Number.isSafeInteger(rect.width) || rect.width <= 0) invalid.push(fieldKeys[2]);
  if (!Number.isSafeInteger(rect.height) || rect.height <= 0) invalid.push(fieldKeys[3]);
  return invalid;
};

const getInvalidRatioRectFields = (
  rect: RatioRect,
  fieldKeys: FieldTuple4
): SettingFieldKey[] => {
  const [rx0Key, ry0Key, rx1Key, ry1Key] = fieldKeys;
  const invalid: SettingFieldKey[] = [];
  const x0Finite = Number.isFinite(rect.rx0);
  const x1Finite = Number.isFinite(rect.rx1);
  if (!x0Finite) invalid.push(rx0Key);
  if (!x1Finite) invalid.push(rx1Key);
  if (x0Finite && x1Finite && clamp01(rect.rx0) === clamp01(rect.rx1)) {
    invalid.push(rx0Key, rx1Key);
  }

  const y0Finite = Number.isFinite(rect.ry0);
  const y1Finite = Number.isFinite(rect.ry1);
  if (!y0Finite) invalid.push(ry0Key);
  if (!y1Finite) invalid.push(ry1Key);
  if (y0Finite && y1Finite && clamp01(rect.ry0) === clamp01(rect.ry1)) {
    invalid.push(ry0Key, ry1Key);
  }
  return invalid;
};

const validateMaskGroup = (params: {
  target: MaskTarget;
  enabled: boolean;
  mode: MaskMode;
  color: string;
  manualRect: PixelRect;
  ratioRect: RatioRect;
}): SettingsValidationResult | null => {
  if (!params.enabled) {
    return null;
  }
  if (!normalizeHexColor(params.color)) {
    return {
      valid: false,
      alertKey: 'alert_invalid_color_setting',
      accordion: params.target,
      fields: [params.target === 'mask' ? 'maskColor' : 'selfMaskColor'],
    };
  }
  if (params.mode === 'manual') {
    const invalidFields = getInvalidPixelRectFields(
      params.manualRect,
      getMaskCoordFieldKeys(params.target)
    );
    if (invalidFields.length > 0) {
      return {
        valid: false,
        alertKey: 'alert_invalid_mask_area',
        accordion: params.target,
        fields: invalidFields,
      };
    }
  }
  if (params.mode === 'ratio') {
    const invalidFields = getInvalidRatioRectFields(
      params.ratioRect,
      getMaskRatioFieldKeys(params.target)
    );
    if (invalidFields.length > 0) {
      return {
        valid: false,
        alertKey: 'alert_invalid_mask_area',
        accordion: params.target,
        fields: invalidFields,
      };
    }
  }
  return null;
};

/**
 * Validates minimum preconditions on `ImageSettings` right before image processing starts:
 * column/offset bounds, opaque hex colors, positive manual crop dimensions, and positive
 * area for enabled manual or ratio masks, returning the target accordion and fields on failure.
 */
export const validateSettingsBeforeProcess = (
  settings: ImageSettings
): SettingsValidationResult => {
  if (!isSafeIntInRange(settings.colCount, MIN_COL_COUNT, MAX_COL_COUNT)) {
    return {
      valid: false,
      alertKey: 'alert_columns_must_be_positive',
      accordion: 'settings',
      fields: ['colCount'],
    };
  }
  if (
    !isSafeIntInRange(settings.offsetX, MIN_OFFSET_PX, MAX_OFFSET_PX) ||
    !isSafeIntInRange(settings.offsetY, MIN_OFFSET_PX, MAX_OFFSET_PX)
  ) {
    return {
      valid: false,
      alertKey: 'alert_offset_cannot_be_empty_or_negative',
      accordion: 'settings',
      fields: ['offsetX'],
    };
  }
  if (!normalizeHexColor(settings.bgColor)) {
    return {
      valid: false,
      alertKey: 'alert_invalid_color_setting',
      accordion: 'settings',
      fields: ['bgColor'],
    };
  }
  if (!settings.cropAuto) {
    const invalidCropFields = getInvalidPixelRectFields(
      {
        x: settings.cropX,
        y: settings.cropY,
        width: settings.cropWidth,
        height: settings.cropHeight,
      },
      CROP_FIELD_KEYS
    );
    if (invalidCropFields.length > 0) {
      return {
        valid: false,
        alertKey: 'alert_invalid_crop_setting',
        accordion: 'crop',
        fields: invalidCropFields,
      };
    }
  }

  const enemyError = validateMaskGroup({
    target: 'mask',
    enabled: settings.maskEnabled,
    mode: settings.maskMode,
    color: settings.maskColor,
    manualRect: {
      x: settings.maskX,
      y: settings.maskY,
      width: settings.maskWidth,
      height: settings.maskHeight,
    },
    ratioRect: settings.maskRatioRect,
  });
  if (enemyError) {
    return enemyError;
  }

  const selfError = validateMaskGroup({
    target: 'selfMask',
    enabled: settings.selfMaskEnabled,
    mode: settings.selfMaskMode,
    color: settings.selfMaskColor,
    manualRect: {
      x: settings.selfMaskX,
      y: settings.selfMaskY,
      width: settings.selfMaskWidth,
      height: settings.selfMaskHeight,
    },
    ratioRect: settings.selfMaskRatioRect,
  });
  if (selfError) {
    return selfError;
  }

  return { valid: true };
};

/**
 * Maps an invalid `MontageSizeEvaluation` reason to the settings accordion and fields
 * responsible for the output dimensions.
 */
export const resolveCanvasSizeErrorUiTarget = (
  reason: MontageSizeEvaluation['reason'],
  cropAuto = true
): ErrorUiTarget => {
  if (reason === 'exceeds_webp_dimension') {
    return { accordions: ['settings'], fields: ['outputFormat', 'colCount'] };
  }
  if (!cropAuto) {
    return {
      accordions: ['settings', 'crop'],
      fields: ['colCount', 'offsetX', 'cropWidth', 'cropHeight'],
    };
  }
  return { accordions: ['settings'], fields: ['colCount', 'offsetX'] };
};

/**
 * Computes a pixel mask rectangle from a ratio rect inside `cropRect`,
 * returning `null` if rounding collapses width or height to 0.
 */
export const computeRatioMaskRect = (
  ratio: RatioRect,
  cropRect: PixelRect
): PixelRect | null => {
  const ordered = getOrderedClampedRatio(ratio);
  if (!ordered || ordered.rx1 <= ordered.rx0 || ordered.ry1 <= ordered.ry0) {
    return null;
  }
  const x0 = cropRect.x + Math.round(ordered.rx0 * cropRect.width);
  const y0 = cropRect.y + Math.round(ordered.ry0 * cropRect.height);
  const x1 = cropRect.x + Math.round(ordered.rx1 * cropRect.width);
  const y1 = cropRect.y + Math.round(ordered.ry1 * cropRect.height);
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { x: x0, y: y0, width, height };
};

/**
 * Returns the intersection of two positive finite rectangles, or `null` if they have zero overlap.
 */
export const intersectPixelRects = (a: PixelRect, b: PixelRect): PixelRect | null => {
  if (
    !Number.isFinite(a.x) ||
    !Number.isFinite(a.y) ||
    !Number.isFinite(a.width) ||
    !Number.isFinite(a.height) ||
    !Number.isFinite(b.x) ||
    !Number.isFinite(b.y) ||
    !Number.isFinite(b.width) ||
    !Number.isFinite(b.height) ||
    a.width <= 0 ||
    a.height <= 0 ||
    b.width <= 0 ||
    b.height <= 0
  ) {
    return null;
  }
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) {
    return null;
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
};

/**
 * Returns true if `cropRect` shares at least a 1x1 pixel overlap with `imageBounds`.
 * Partial overhangs are tolerated as long as there is overlap.
 */
export const hasCropOverlapWithImage = (
  cropRect: PixelRect,
  imageBounds: Pick<PixelRect, 'width' | 'height'>
): boolean =>
  intersectPixelRects(cropRect, {
    x: 0,
    y: 0,
    width: imageBounds.width,
    height: imageBounds.height,
  }) !== null;

/** Formats a normalized 0..1 ratio value as a compact percentage string (e.g., `0.785` -> `78.5%`). */
export const formatRatioPercent = (value: number): string => {
  if (!Number.isFinite(value)) {
    return '0%';
  }
  const clamped = clamp01(value);
  const percent = Number((clamped * 100).toFixed(1));
  return `${percent}%`;
};

/**
 * Converts a normalized 0..1 ratio to the percent number shown in ratio inputs (e.g., `0.785` -> `78.5`),
 * rounded to 4 decimals to drop float noise such as `78.50000000000001`.
 */
export const ratioToPercentInput = (ratio: number): number => Math.round(ratio * 1_000_000) / 10_000;

/**
 * Converts a percent number typed into a ratio input back to a normalized ratio (e.g., `78.5` -> `0.785`),
 * keeping 6 decimals (= 4 decimals of percent) without float noise. Clamping is left to the caller.
 */
export const percentInputToRatio = (percent: number): number => Math.round(percent * 10_000) / 1_000_000;

export interface RatioMaskOverlayBox {
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
}

/**
 * Converts a normalized `RatioRect` into percentage CSS positioning (`0..100`)
 * over a cropped preview image, returning `null` when invalid or zero-area.
 */
export const computeRatioMaskOverlayBox = (
  ratio: RatioRect
): RatioMaskOverlayBox | null => {
  const ordered = getOrderedClampedRatio(ratio);
  if (!ordered || ordered.rx1 <= ordered.rx0 || ordered.ry1 <= ordered.ry0) {
    return null;
  }
  const toPercent = (v: number): number => Math.round(v * 1_000_000) / 10_000;
  return {
    leftPct: toPercent(ordered.rx0),
    topPct: toPercent(ordered.ry0),
    widthPct: toPercent(ordered.rx1 - ordered.rx0),
    heightPct: toPercent(ordered.ry1 - ordered.ry0),
  };
};
