import type { OcrMaskDetectionResult, PixelRect } from './ocrHelpers.ts';
import {
  computeRatioMaskRect,
  cropRectToSettings,
  hasCropOverlapWithImage,
  intersectPixelRects,
  type ImageSettings,
  type OutputFormat,
} from './settingsHelpers.ts';

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface BitmapLike {
  readonly width?: number;
  readonly height?: number;
  close: () => void;
}

export interface TileMaskRect extends PixelRect {
  color: string;
}

export interface MontageContextLike<B extends BitmapLike> {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect: (x: number, y: number, w: number, h: number) => void;
  drawImage: (
    image: B,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number
  ) => void;
}

export interface BuildTileMaskRectsParams {
  cropRect: PixelRect;
  maskEnabled: boolean;
  maskRect: PixelRect | null;
  maskColor: string;
  selfMaskEnabled: boolean;
  selfMaskRect: PixelRect | null;
  selfMaskColor: string;
}

export interface RenderMontageTilesOptions<F, B extends BitmapLike> {
  files: readonly F[];
  colCount: number;
  offsetX: number;
  offsetY: number;
  cropRect: PixelRect;
  masks: readonly TileMaskRect[];
  montageCtx: MontageContextLike<B>;
  decodeImage: (file: F, index: number) => Promise<B>;
  expectedDimensions?: ImageDimensions;
  getFileName?: (file: F) => string;
  yieldFrame?: () => Promise<void>;
}

/** Converts enabled mask rectangles from full-image space into crop-clipped tile-relative coordinates. */
export const buildTileMaskRects = (params: BuildTileMaskRectsParams): TileMaskRect[] => {
  const masks: TileMaskRect[] = [];
  const appendClippedMask = (
    enabled: boolean,
    rect: PixelRect | null | undefined,
    color: string
  ) => {
    if (!enabled || !rect) return;
    const clipped = intersectPixelRects(rect, params.cropRect);
    if (!clipped) return;
    masks.push({
      x: clipped.x - params.cropRect.x,
      y: clipped.y - params.cropRect.y,
      width: clipped.width,
      height: clipped.height,
      color,
    });
  };
  appendClippedMask(params.maskEnabled, params.maskRect, params.maskColor);
  appendClippedMask(params.selfMaskEnabled, params.selfMaskRect, params.selfMaskColor);
  return masks;
};

const defaultYieldFrame = (): Promise<void> =>
  typeof requestAnimationFrame === 'function'
    ? new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    : Promise.resolve();

const defaultGetFileName = <F>(file: F): string => {
  if (typeof file === 'object' && file !== null && 'name' in file) {
    const name = (file as { name?: unknown }).name;
    if (typeof name === 'string') {
      return name;
    }
  }
  return String(file);
};

/** Error identifying a file whose dimensions differ from the expected image resolution. */
export class ImageResolutionMismatchError extends Error {
  readonly fileName: string;
  readonly expectedWidth: number;
  readonly expectedHeight: number;
  readonly actualWidth: number;
  readonly actualHeight: number;

  constructor(params: {
    fileName: string;
    expectedWidth: number;
    expectedHeight: number;
    actualWidth: number;
    actualHeight: number;
  }) {
    super(
      `Image resolution mismatch for "${params.fileName}": expected ${params.expectedWidth}x${params.expectedHeight}, got ${params.actualWidth}x${params.actualHeight}`
    );
    this.name = 'ImageResolutionMismatchError';
    this.fileName = params.fileName;
    this.expectedWidth = params.expectedWidth;
    this.expectedHeight = params.expectedHeight;
    this.actualWidth = params.actualWidth;
    this.actualHeight = params.actualHeight;
  }
}

/**
 * Draws cropped image tiles and clipped mask rectangles directly onto the montage context,
 * guaranteeing each decoded ImageBitmap is closed in a `finally` block without allocating a temp canvas.
 */
export const renderMontageTiles = async <F, B extends BitmapLike>(
  options: RenderMontageTilesOptions<F, B>
): Promise<void> => {
  const {
    files,
    colCount,
    offsetX,
    offsetY,
    cropRect,
    masks,
    montageCtx,
    decodeImage,
    expectedDimensions,
    getFileName = defaultGetFileName,
    yieldFrame = defaultYieldFrame,
  } = options;

  if (files.length === 0) {
    return;
  }

  // Clamp masks to tile bounds so direct callers cannot paint into offsets or neighbor tiles.
  const tileBounds: PixelRect = { x: 0, y: 0, width: cropRect.width, height: cropRect.height };
  const clippedMasks: TileMaskRect[] = [];
  for (const mask of masks) {
    const clipped = intersectPixelRects(mask, tileBounds);
    if (clipped) {
      clippedMasks.push({ ...clipped, color: mask.color });
    }
  }

  for (let i = 0; i < files.length; i++) {
    const row = Math.floor(i / colCount);
    const col = i % colCount;
    const drawX = offsetX + col * (cropRect.width + offsetX);
    const drawY = offsetY + row * (cropRect.height + offsetY);

    const bitmap = await decodeImage(files[i], i);
    try {
      if (
        expectedDimensions &&
        (bitmap.width !== expectedDimensions.width ||
          bitmap.height !== expectedDimensions.height)
      ) {
        throw new ImageResolutionMismatchError({
          fileName: getFileName(files[i]),
          expectedWidth: expectedDimensions.width,
          expectedHeight: expectedDimensions.height,
          actualWidth: typeof bitmap.width === 'number' ? bitmap.width : 0,
          actualHeight: typeof bitmap.height === 'number' ? bitmap.height : 0,
        });
      }

      montageCtx.drawImage(
        bitmap,
        cropRect.x,
        cropRect.y,
        cropRect.width,
        cropRect.height,
        drawX,
        drawY,
        cropRect.width,
        cropRect.height
      );
    } finally {
      bitmap.close();
    }

    for (const mask of clippedMasks) {
      montageCtx.fillStyle = mask.color;
      montageCtx.fillRect(drawX + mask.x, drawY + mask.y, mask.width, mask.height);
    }

    await yieldFrame();
  }
};

export interface NamedFileLike {
  name: string;
}

export interface DecodeFallbackImageLike {
  decoding: string;
  naturalWidth: number;
  naturalHeight: number;
  onload: (() => void) | null;
  onerror: ((event?: unknown) => void) | null;
  src: string;
}

export interface DecodeFallbackCanvasLike {
  width: number;
  height: number;
  getContext: (
    contextId: '2d',
    options?: CanvasRenderingContext2DSettings
  ) => {
    drawImage: (image: DecodeFallbackImageLike, dx: number, dy: number) => void;
  } | null;
}

export interface DecodeImageWithFallbackDeps<F extends NamedFileLike, B extends BitmapLike> {
  primaryDecode?: (file: F) => Promise<B>;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  createObjectURL?: (file: F) => string;
  revokeObjectURL?: (url: string) => void;
  createImage?: () => DecodeFallbackImageLike;
  createCanvas?: () => DecodeFallbackCanvasLike;
  decodeCanvas?: (canvas: DecodeFallbackCanvasLike) => Promise<B>;
  onPrimaryError?: (file: F, error: unknown) => void;
}

/** Error identifying the exact file that failed both primary and fallback image decoding. */
export class ImageDecodeError extends Error {
  readonly fileName: string;

  constructor(fileName: string, options?: { cause?: unknown }) {
    super(`Failed to decode image: ${fileName}`, options);
    this.name = 'ImageDecodeError';
    this.fileName = fileName;
  }
}

/**
 * Decodes an image file via `createImageBitmap`, falling back to `Image` + temporary canvas
 * decoding if primary decoding fails, and throws `ImageDecodeError` naming the file on failure.
 */
export const decodeImageWithFallback = async <
  F extends NamedFileLike = File,
  B extends BitmapLike = ImageBitmap,
>(
  file: F,
  deps: DecodeImageWithFallbackDeps<F, B> = {}
): Promise<B> => {
  const {
    primaryDecode = (target) =>
      createImageBitmap(target as unknown as ImageBitmapSource) as unknown as Promise<B>,
    retryDelayMs = 200,
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    createObjectURL = (target) => URL.createObjectURL(target as unknown as Blob),
    revokeObjectURL = (url) => URL.revokeObjectURL(url),
    createImage = () => new Image() as unknown as DecodeFallbackImageLike,
    createCanvas = () => document.createElement('canvas') as unknown as DecodeFallbackCanvasLike,
    decodeCanvas = (canvas) =>
      createImageBitmap(canvas as unknown as HTMLCanvasElement) as unknown as Promise<B>,
    onPrimaryError = (target, error) =>
      console.warn(`createImageBitmap failed for "${target.name}", falling back to Image element:`, error),
  } = deps;

  try {
    return await primaryDecode(file);
  } catch (primaryError) {
    onPrimaryError(file, primaryError);
    if (retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }

    let url: string | null = null;
    try {
      url = createObjectURL(file);
      const img = createImage();
      img.decoding = 'async';
      try {
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error(`Failed to load image "${file.name}" from object URL`));
          img.src = url!;
        });
      } finally {
        img.onload = null;
        img.onerror = null;
      }

      if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
        throw new Error(`Decoded fallback image "${file.name}" has invalid dimensions`, {
          cause: primaryError,
        });
      }

      const canvas = createCanvas();
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
        if (!ctx) {
          throw new Error('Failed to get 2D context for fallback image decode canvas', {
            cause: primaryError,
          });
        }
        ctx.drawImage(img, 0, 0);
        return await decodeCanvas(canvas);
      } finally {
        canvas.width = 1;
        canvas.height = 1;
      }
    } catch (fallbackError) {
      throw new ImageDecodeError(file.name, { cause: fallbackError });
    } finally {
      if (url !== null) {
        revokeObjectURL(url);
      }
    }
  }
};

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
};

const FORMAT_TO_EXTENSION: Record<OutputFormat, string> = {
  webp: 'webp',
  png: 'png',
  jpeg: 'jpg',
};

/**
 * Resolves the download file extension from the actual Blob MIME type produced by canvas.toBlob(),
 * falling back to the requested format when blobType is empty or unrecognized.
 */
export const resolveOutputExtension = (
  blobType: string | undefined | null,
  requestedFormat: OutputFormat
): string => {
  const normalizedMime = (blobType ?? '').split(';', 1)[0].trim().toLowerCase();
  if (Object.hasOwn(MIME_TO_EXTENSION, normalizedMime)) {
    return MIME_TO_EXTENSION[normalizedMime];
  }
  return FORMAT_TO_EXTENSION[requestedFormat] ?? 'webp';
};

export type PrepareMontagePlanAlert =
  | { kind: 'auto_crop_context_error' }
  | { kind: 'auto_crop_not_found' }
  | { kind: 'crop_outside_image'; width: number; height: number }
  | { kind: 'invalid_mask_area' }
  | { kind: 'mask_outside_crop' }
  | { kind: 'ocr_not_found'; enemyMissing: boolean; selfMissing: boolean }
  | { kind: 'ocr_error'; error: unknown }
  | { kind: 'ocr_aborted' };

export type PrepareMontagePlanResult =
  | {
      status: 'ok';
      cropRect: PixelRect;
      finalSettings: ImageSettings;
      settingsPatch: Partial<ImageSettings>;
      tileMasks: TileMaskRect[];
    }
  | {
      status: 'abort';
      settingsPatch: Partial<ImageSettings>;
      alert: PrepareMontagePlanAlert;
    };

export interface PrepareMontagePlanOptions {
  settings: ImageSettings;
  imageSize: ImageDimensions;
  detectAutoCrop: () =>
    | { status: 'ok'; rect: PixelRect }
    | { status: 'context_error' }
    | { status: 'not_found' };
  detectOcrMasks: (params: {
    cropRect: PixelRect;
    needsEnemyOcr: boolean;
    needsSelfOcr: boolean;
  }) => Promise<OcrMaskDetectionResult>;
}

const buildMaskCoordPatch = (
  prefix: 'mask' | 'selfMask',
  rect: PixelRect
): Partial<ImageSettings> =>
  prefix === 'mask'
    ? { maskX: rect.x, maskY: rect.y, maskWidth: rect.width, maskHeight: rect.height }
    : { selfMaskX: rect.x, selfMaskY: rect.y, selfMaskWidth: rect.width, selfMaskHeight: rect.height };

const resolveStaticMaskRect = (
  enabled: boolean,
  mode: ImageSettings['maskMode'],
  manualRect: PixelRect,
  ratioRect: ImageSettings['maskRatioRect'],
  cropRect: PixelRect
):
  | { ok: true; rect: PixelRect | null; needsRatioPatch: boolean }
  | { ok: false; reason: 'invalid_mask_area' | 'mask_outside_crop' } => {
  if (!enabled) {
    return { ok: true, rect: null, needsRatioPatch: false };
  }
  if (mode === 'manual') {
    if (
      !Number.isFinite(manualRect.x) ||
      !Number.isFinite(manualRect.y) ||
      !Number.isFinite(manualRect.width) ||
      !Number.isFinite(manualRect.height) ||
      manualRect.width <= 0 ||
      manualRect.height <= 0
    ) {
      return { ok: false, reason: 'invalid_mask_area' };
    }
    const clipped = intersectPixelRects(manualRect, cropRect);
    if (!clipped) {
      return { ok: false, reason: 'mask_outside_crop' };
    }
    return { ok: true, rect: clipped, needsRatioPatch: false };
  }
  if (mode === 'ratio') {
    const computed = computeRatioMaskRect(ratioRect, cropRect);
    if (!computed) {
      return { ok: false, reason: 'invalid_mask_area' };
    }
    return { ok: true, rect: computed, needsRatioPatch: true };
  }
  return { ok: true, rect: null, needsRatioPatch: false };
};

/**
 * Resolves the active crop rectangle, static/OCR mask rectangles, and settings updates before
 * montage rendering. Keeps `maskMode` / `selfMaskMode` set to `'ocr'` when OCR fails so retries
 * never silently fall back to stale manual coordinates.
 */
export const prepareMontagePlan = async ({
  settings,
  imageSize,
  detectAutoCrop,
  detectOcrMasks,
}: PrepareMontagePlanOptions): Promise<PrepareMontagePlanResult> => {
  let cropRect: PixelRect = {
    x: settings.cropX,
    y: settings.cropY,
    width: settings.cropWidth,
    height: settings.cropHeight,
  };
  const settingsPatch: Partial<ImageSettings> = {};

  if (settings.cropAuto) {
    const autoCropResult = detectAutoCrop();
    if (autoCropResult.status !== 'ok') {
      const isContextError = autoCropResult.status === 'context_error';
      return {
        status: 'abort',
        // Context errors are transient runtime failures, so preserve cropAuto for retries;
        // only switch to manual mode when auto-crop border detection finds no bounds.
        settingsPatch: isContextError ? {} : { cropAuto: false },
        alert: {
          kind: isContextError ? 'auto_crop_context_error' : 'auto_crop_not_found',
        },
      };
    }
    cropRect = autoCropResult.rect;
    Object.assign(settingsPatch, cropRectToSettings(cropRect));
  } else if (!hasCropOverlapWithImage(cropRect, imageSize)) {
    return {
      status: 'abort',
      settingsPatch: {},
      alert: {
        kind: 'crop_outside_image',
        width: imageSize.width,
        height: imageSize.height,
      },
    };
  }

  const enemyStatic = resolveStaticMaskRect(
    settings.maskEnabled,
    settings.maskMode,
    {
      x: settings.maskX,
      y: settings.maskY,
      width: settings.maskWidth,
      height: settings.maskHeight,
    },
    settings.maskRatioRect,
    cropRect
  );
  if (!enemyStatic.ok) {
    return {
      status: 'abort',
      settingsPatch,
      alert: { kind: enemyStatic.reason },
    };
  }

  const selfStatic = resolveStaticMaskRect(
    settings.selfMaskEnabled,
    settings.selfMaskMode,
    {
      x: settings.selfMaskX,
      y: settings.selfMaskY,
      width: settings.selfMaskWidth,
      height: settings.selfMaskHeight,
    },
    settings.selfMaskRatioRect,
    cropRect
  );
  if (!selfStatic.ok) {
    return {
      status: 'abort',
      settingsPatch,
      alert: { kind: selfStatic.reason },
    };
  }

  let enemyMaskRect = enemyStatic.rect;
  let selfMaskRect = selfStatic.rect;
  if (enemyStatic.needsRatioPatch && enemyMaskRect) {
    Object.assign(settingsPatch, buildMaskCoordPatch('mask', enemyMaskRect));
  }
  if (selfStatic.needsRatioPatch && selfMaskRect) {
    Object.assign(settingsPatch, buildMaskCoordPatch('selfMask', selfMaskRect));
  }

  const needsEnemyOcr = settings.maskEnabled && settings.maskMode === 'ocr';
  const needsSelfOcr = settings.selfMaskEnabled && settings.selfMaskMode === 'ocr';

  if (needsEnemyOcr || needsSelfOcr) {
    const ocrOutcome = await detectOcrMasks({
      cropRect,
      needsEnemyOcr,
      needsSelfOcr,
    });

    if (ocrOutcome.status === 'aborted') {
      return {
        status: 'abort',
        settingsPatch,
        alert: { kind: 'ocr_aborted' },
      };
    }
    if (ocrOutcome.status === 'error') {
      return {
        status: 'abort',
        settingsPatch,
        alert: { kind: 'ocr_error', error: ocrOutcome.error },
      };
    }
    if (ocrOutcome.status === 'not_found') {
      return {
        status: 'abort',
        settingsPatch,
        alert: {
          kind: 'ocr_not_found',
          enemyMissing: ocrOutcome.enemyMissing,
          selfMissing: ocrOutcome.selfMissing,
        },
      };
    }

    if (needsEnemyOcr && ocrOutcome.enemyMaskRect) {
      enemyMaskRect = ocrOutcome.enemyMaskRect;
      Object.assign(settingsPatch, buildMaskCoordPatch('mask', enemyMaskRect));
    }
    if (needsSelfOcr && ocrOutcome.selfMaskRect) {
      selfMaskRect = ocrOutcome.selfMaskRect;
      Object.assign(settingsPatch, buildMaskCoordPatch('selfMask', selfMaskRect));
    }
  }

  if ((settings.maskEnabled && !enemyMaskRect) || (settings.selfMaskEnabled && !selfMaskRect)) {
    return {
      status: 'abort',
      settingsPatch,
      alert: {
        kind: 'ocr_not_found',
        enemyMissing: settings.maskEnabled && !enemyMaskRect,
        selfMissing: settings.selfMaskEnabled && !selfMaskRect,
      },
    };
  }

  const finalSettings: ImageSettings = { ...settings, ...settingsPatch };
  const tileMasks = buildTileMaskRects({
    cropRect,
    maskEnabled: finalSettings.maskEnabled,
    maskRect: enemyMaskRect,
    maskColor: finalSettings.maskColor,
    selfMaskEnabled: finalSettings.selfMaskEnabled,
    selfMaskRect,
    selfMaskColor: finalSettings.selfMaskColor,
  });

  return {
    status: 'ok',
    cropRect,
    finalSettings,
    settingsPatch,
    tileMasks,
  };
};
