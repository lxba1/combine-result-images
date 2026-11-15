import type { PixelRect } from './ocrHelpers.ts';
import type { OutputFormat } from './settingsHelpers.ts';

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

export interface MontageContextLike<B extends BitmapLike, C> {
  drawImage: {
    (image: C, dx: number, dy: number): void;
    (
      image: B,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number
    ): void;
  };
}

export interface TileTempContextLike<B extends BitmapLike> {
  fillStyle: string | CanvasGradient | CanvasPattern;
  clearRect: (x: number, y: number, w: number, h: number) => void;
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

export interface TileTempCanvasLike<B extends BitmapLike> {
  width: number;
  height: number;
  getContext: (
    contextId: '2d',
    options?: CanvasRenderingContext2DSettings
  ) => TileTempContextLike<B> | null;
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

export interface RenderMontageTilesOptions<
  F,
  B extends BitmapLike,
  C extends TileTempCanvasLike<B> = TileTempCanvasLike<B>,
> {
  files: readonly F[];
  colCount: number;
  offsetX: number;
  offsetY: number;
  cropRect: PixelRect;
  masks: readonly TileMaskRect[];
  montageCtx: MontageContextLike<B, C>;
  decodeImage: (file: F) => Promise<B>;
  expectedDimensions?: ImageDimensions;
  getFileName?: (file: F) => string;
  yieldFrame?: () => Promise<void>;
  createTempCanvas?: () => C;
}

/** Converts enabled mask rectangles from full-image space into tile-relative coordinates. */
export const buildTileMaskRects = (params: BuildTileMaskRectsParams): TileMaskRect[] => {
  const masks: TileMaskRect[] = [];
  if (params.maskEnabled && params.maskRect && params.maskRect.width > 0 && params.maskRect.height > 0) {
    masks.push({
      x: params.maskRect.x - params.cropRect.x,
      y: params.maskRect.y - params.cropRect.y,
      width: params.maskRect.width,
      height: params.maskRect.height,
      color: params.maskColor,
    });
  }
  if (
    params.selfMaskEnabled &&
    params.selfMaskRect &&
    params.selfMaskRect.width > 0 &&
    params.selfMaskRect.height > 0
  ) {
    masks.push({
      x: params.selfMaskRect.x - params.cropRect.x,
      y: params.selfMaskRect.y - params.cropRect.y,
      width: params.selfMaskRect.width,
      height: params.selfMaskRect.height,
      color: params.selfMaskColor,
    });
  }
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
 * Draws cropped image tiles onto the montage context, guaranteeing each decoded ImageBitmap is
 * closed in a `finally` block and allocating a temporary canvas only once when masks are active.
 */
export const renderMontageTiles = async <
  F,
  B extends BitmapLike,
  C extends TileTempCanvasLike<B> = TileTempCanvasLike<B>,
>(
  options: RenderMontageTilesOptions<F, B, C>
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
    createTempCanvas = () => document.createElement('canvas') as unknown as C,
  } = options;

  if (files.length === 0) {
    return;
  }

  let tempCanvas: C | null = null;
  let tempCtx: TileTempContextLike<B> | null = null;

  try {
    if (masks.length > 0) {
      tempCanvas = createTempCanvas();
      tempCanvas.width = cropRect.width;
      tempCanvas.height = cropRect.height;
      tempCtx = tempCanvas.getContext('2d', { alpha: false });
      if (!tempCtx) {
        throw new Error('Could not get reusable temporary canvas context');
      }
    }

    for (let i = 0; i < files.length; i++) {
      const row = Math.floor(i / colCount);
      const col = i % colCount;
      const drawX = offsetX + col * (cropRect.width + offsetX);
      const drawY = offsetY + row * (cropRect.height + offsetY);

      const bitmap = await decodeImage(files[i]);
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

        if (tempCanvas && tempCtx) {
          // Clear rather than reassigning canvas width/height, which would reallocate the backing store each frame.
          tempCtx.clearRect(0, 0, cropRect.width, cropRect.height);
          tempCtx.drawImage(
            bitmap,
            cropRect.x,
            cropRect.y,
            cropRect.width,
            cropRect.height,
            0,
            0,
            cropRect.width,
            cropRect.height
          );
        } else {
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
        }
      } finally {
        bitmap.close();
      }

      if (tempCanvas && tempCtx) {
        for (const mask of masks) {
          tempCtx.fillStyle = mask.color;
          tempCtx.fillRect(mask.x, mask.y, mask.width, mask.height);
        }
        montageCtx.drawImage(tempCanvas, drawX, drawY);
      }

      await yieldFrame();
    }
  } finally {
    if (tempCanvas) {
      tempCanvas.width = 1;
      tempCanvas.height = 1;
    }
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
