import type { AutoCropResult } from './cropHelpers.ts';
import {
  createAbortError,
  isAbortError,
  type OcrMaskDetectionResult,
  type PixelRect,
} from './ocrHelpers.ts';
import {
  CROP_FIELD_KEYS,
  computeRatioMaskRect,
  cropRectToSettings,
  getMaskCoordFieldKeys,
  getMaskRatioFieldKeys,
  hasCropOverlapWithImage,
  intersectPixelRects,
  type ErrorUiTarget,
  type ImageSettings,
  type MaskTarget,
  type OutputFormat,
  type SettingsAccordionId,
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
  getImageData?: (
    sx: number,
    sy: number,
    sw: number,
    sh: number
  ) => { data: ArrayLike<number> };
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
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
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

/** Returns the bitmap's pixel bounds, or `null` when it does not report a usable size. */
const getBitmapBounds = (bitmap: BitmapLike): PixelRect | null => {
  const { width, height } = bitmap;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { x: 0, y: 0, width, height };
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw createAbortError();
  }
};

/**
 * Draws cropped image tiles and clipped mask rectangles directly onto the montage context,
 * guaranteeing each decoded ImageBitmap is closed in a `finally` block without allocating a temp canvas,
 * reporting tile progress and supporting cooperative AbortSignal cancellation between frames.
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
    signal,
    onProgress,
  } = options;

  if (files.length === 0) {
    return;
  }

  throwIfAborted(signal);
  onProgress?.(0, files.length);

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
    throwIfAborted(signal);
    const row = Math.floor(i / colCount);
    const col = i % colCount;
    const drawX = offsetX + col * (cropRect.width + offsetX);
    const drawY = offsetY + row * (cropRect.height + offsetY);

    const bitmap = await decodeImage(files[i], i);
    try {
      throwIfAborted(signal);
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

      // A manual crop may overhang the image edges. Clip the source to the bitmap ourselves:
      // WebKit has mishandled out-of-bounds source rects (dropping or shifting the image),
      // while clipping here gives the spec result everywhere and leaves the overhang as bgColor.
      const bitmapBounds = getBitmapBounds(bitmap);
      const source = bitmapBounds ? intersectPixelRects(cropRect, bitmapBounds) : cropRect;
      if (source) {
        montageCtx.drawImage(
          bitmap,
          source.x,
          source.y,
          source.width,
          source.height,
          drawX + (source.x - cropRect.x),
          drawY + (source.y - cropRect.y),
          source.width,
          source.height
        );
      }
    } finally {
      bitmap.close();
    }

    for (const mask of clippedMasks) {
      montageCtx.fillStyle = mask.color;
      montageCtx.fillRect(drawX + mask.x, drawY + mask.y, mask.width, mask.height);
    }

    onProgress?.(i + 1, files.length);
    await yieldFrame();
    throwIfAborted(signal);
  }
};

export interface MontageCanvasLike<B extends BitmapLike> {
  width: number;
  height: number;
  getContext: (
    contextId: '2d',
    options?: CanvasRenderingContext2DSettings
  ) => MontageContextLike<B> | null;
  toBlob: (
    callback: (blob: Blob | null) => void,
    type?: string,
    quality?: number
  ) => void;
}

const matchesAscii = (bytes: Uint8Array, offset: number, ascii: string): boolean => {
  if (offset + ascii.length > bytes.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
};

const parsePngDimensions = (bytes: Uint8Array, view: DataView): ImageDimensions | null => {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    !matchesAscii(bytes, 1, 'PNG\r\n\x1a\n') ||
    !matchesAscii(bytes, 12, 'IHDR')
  ) {
    return null;
  }
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return width > 0 && height > 0 ? { width, height } : null;
};

const parseWebpDimensions = (bytes: Uint8Array, view: DataView): ImageDimensions | null => {
  if (!matchesAscii(bytes, 0, 'RIFF') || !matchesAscii(bytes, 8, 'WEBP')) {
    return null;
  }
  if (matchesAscii(bytes, 12, 'VP8 ')) {
    if (
      bytes.length < 30 ||
      (bytes[20] & 0x01) !== 0 ||
      bytes[23] !== 0x9d ||
      bytes[24] !== 0x01 ||
      bytes[25] !== 0x2a
    ) {
      return null;
    }
    const width = view.getUint16(26, true) & 0x3fff;
    const height = view.getUint16(28, true) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (matchesAscii(bytes, 12, 'VP8L')) {
    if (bytes.length < 25 || bytes[20] !== 0x2f) {
      return null;
    }
    const bits = view.getUint32(21, true);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (matchesAscii(bytes, 12, 'VP8X')) {
    if (bytes.length < 30) {
      return null;
    }
    const width = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
    const height = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
};

const parseJpegDimensions = (bytes: Uint8Array, view: DataView): ImageDimensions | null => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      break;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.length) {
      break;
    }
    const marker = bytes[offset];
    offset += 1;
    // Standalone markers without a segment payload
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) break;
      continue;
    }
    // Start of Scan: SOF frame markers always precede entropy-coded scan data
    if (marker === 0xda || offset + 2 > bytes.length) {
      break;
    }
    const segmentLength = view.getUint16(offset, false);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      break;
    }
    const isSofMarker =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSofMarker) {
      if (segmentLength < 7 || offset + 7 > bytes.length) {
        break;
      }
      const height = view.getUint16(offset + 3, false);
      const width = view.getUint16(offset + 5, false);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += segmentLength;
  }
  return null;
};

/**
 * Parses pixel dimensions from PNG, WebP, or JPEG container header bytes without decoding
 * full image pixel buffers. Returns `null` when bytes are unrecognized or truncated.
 */
export const parseImageDimensionsFromBytes = (bytes: Uint8Array): ImageDimensions | null => {
  if (bytes.length < 4) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    parsePngDimensions(bytes, view) ??
    parseWebpDimensions(bytes, view) ??
    parseJpegDimensions(bytes, view)
  );
};

const MAX_HEADER_INSPECT_BYTES = 131_072;

/**
 * Reads encoded dimensions from an output Blob header without decoding full uncompressed
 * pixel buffers into GPU/RAM. Returns `null` if the header cannot be parsed.
 */
export const readEncodedImageDimensions = async (
  blob: Blob
): Promise<ImageDimensions | null> => {
  if (!blob || typeof blob.slice !== 'function') {
    return null;
  }
  try {
    const headerSlice = blob.slice(0, MAX_HEADER_INSPECT_BYTES);
    if (typeof headerSlice.arrayBuffer !== 'function') {
      return null;
    }
    const bytes = new Uint8Array(await headerSlice.arrayBuffer());
    return parseImageDimensionsFromBytes(bytes);
  } catch {
    return null;
  }
};

/**
 * Waits for `canvas.toBlob`, rejecting with an AbortError as soon as `signal` aborts so a cancel
 * during a long encode returns right away. The browser encodes its own snapshot of the bitmap and
 * keeps going after that; its late callback is ignored.
 */
const encodeCanvasToBlob = <B extends BitmapLike>(
  canvas: MontageCanvasLike<B>,
  mimeType: string,
  quality: number,
  signal?: AbortSignal
): Promise<Blob | null> =>
  new Promise<Blob | null>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    let settled = false;
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      reject(createAbortError());
    };
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', handleAbort);
      finish();
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
    try {
      canvas.toBlob((blob) => settle(() => resolve(blob)), mimeType, quality);
    } catch (error) {
      settle(() => reject(error));
    }
  });

export interface RenderMontageToBlobOptions<F, B extends BitmapLike>
  extends Omit<RenderMontageTilesOptions<F, B>, 'montageCtx'> {
  dimensions: ImageDimensions;
  bgColor: string;
  mimeType: string;
  quality: number;
  /** Persistent canvas element to reuse across runs (preferred over allocating a detached canvas per run). */
  canvas?: MontageCanvasLike<B> | null;
  createCanvas?: () => MontageCanvasLike<B>;
  inspectBlobDimensions?: (blob: Blob) => Promise<ImageDimensions | null>;
  onPhaseChange?: (phase: 'drawing' | 'encoding') => void;
}

export type RenderMontageToBlobResult =
  | { status: 'ok'; blob: Blob }
  | { status: 'aborted' }
  | { status: 'allocation_failed' }
  | { status: 'context_failed' }
  | { status: 'encode_failed' }
  | { status: 'dimension_mismatch'; actualWidth: number; actualHeight: number };

const ALLOCATION_PROBE_COLOR = '#55aa55';
const ALLOCATION_PROBE_RGB: readonly [number, number, number] = [0x55, 0xaa, 0x55];
const ALLOCATION_PROBE_TOLERANCE = 8;

const verifyCanvasBackingAllocation = <B extends BitmapLike>(
  montageCtx: MontageContextLike<B>,
  width: number,
  height: number
): boolean => {
  if (width <= 0 || height <= 0) {
    return false;
  }
  if (typeof montageCtx.getImageData !== 'function') {
    return true;
  }
  try {
    const probeX = width - 1;
    const probeY = height - 1;
    montageCtx.fillStyle = ALLOCATION_PROBE_COLOR;
    montageCtx.fillRect(probeX, probeY, 1, 1);
    const { data } = montageCtx.getImageData(probeX, probeY, 1, 1);
    if (!data || data.length < 4) {
      return false;
    }
    return (
      Math.abs(data[0] - ALLOCATION_PROBE_RGB[0]) <= ALLOCATION_PROBE_TOLERANCE &&
      Math.abs(data[1] - ALLOCATION_PROBE_RGB[1]) <= ALLOCATION_PROBE_TOLERANCE &&
      Math.abs(data[2] - ALLOCATION_PROBE_RGB[2]) <= ALLOCATION_PROBE_TOLERANCE &&
      data[3] === 255
    );
  } catch {
    return false;
  }
};

/**
 * Renders the full montage onto a reusable `canvas` (or falls back to `createCanvas()`),
 * verifies its backing store can actually be drawn and read, encodes the output Blob, immediately
 * shrinks the canvas to 1x1 so Chromium can promptly reclaim its pixel backing store and GPU
 * transfer buffers, and verifies encoded container dimensions against the requested output size.
 */
export const renderMontageToBlob = async <F, B extends BitmapLike>({
  dimensions,
  bgColor,
  mimeType,
  quality,
  canvas,
  createCanvas = () => document.createElement('canvas') as unknown as MontageCanvasLike<B>,
  inspectBlobDimensions = readEncodedImageDimensions,
  onPhaseChange,
  ...tileOptions
}: RenderMontageToBlobOptions<F, B>): Promise<RenderMontageToBlobResult> => {
  if (tileOptions.signal?.aborted) {
    return { status: 'aborted' };
  }
  const montageCanvas = canvas ?? createCanvas();
  const shrinkCanvas = () => {
    if (montageCanvas.width !== 1 || montageCanvas.height !== 1) {
      montageCanvas.width = 1;
      montageCanvas.height = 1;
    }
  };
  try {
    // willReadFrequently keeps the montage on a CPU-backed canvas. On a GPU canvas, toBlob (and
    // the allocation probe) first read the full montage back from the GPU, which blocked the
    // main thread for ~0.1s at encode start on desktop and keeps a second full-size copy in
    // memory while encoding. Each tile is drawn 1:1 once, so CPU drawing costs about the same.
    const montageCtx = montageCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!montageCtx) {
      return { status: 'context_failed' };
    }

    montageCanvas.width = dimensions.width;
    montageCanvas.height = dimensions.height;
    if (
      montageCanvas.width !== dimensions.width ||
      montageCanvas.height !== dimensions.height ||
      !verifyCanvasBackingAllocation(montageCtx, montageCanvas.width, montageCanvas.height)
    ) {
      return { status: 'allocation_failed' };
    }

    montageCtx.fillStyle = bgColor;
    montageCtx.fillRect(0, 0, montageCanvas.width, montageCanvas.height);

    onPhaseChange?.('drawing');
    await renderMontageTiles({
      ...tileOptions,
      montageCtx,
    });
    throwIfAborted(tileOptions.signal);

    onPhaseChange?.('encoding');
    const montageBlob = await encodeCanvasToBlob(
      montageCanvas,
      mimeType,
      quality,
      tileOptions.signal
    );
    shrinkCanvas();
    throwIfAborted(tileOptions.signal);
    if (!montageBlob || montageBlob.size === 0) {
      return { status: 'encode_failed' };
    }
    const actualDimensions = await inspectBlobDimensions(montageBlob);
    throwIfAborted(tileOptions.signal);
    if (
      actualDimensions &&
      (actualDimensions.width !== dimensions.width ||
        actualDimensions.height !== dimensions.height)
    ) {
      return {
        status: 'dimension_mismatch',
        actualWidth: actualDimensions.width,
        actualHeight: actualDimensions.height,
      };
    }
    return { status: 'ok', blob: montageBlob };
  } catch (error) {
    if (tileOptions.signal?.aborted || isAbortError(error)) {
      return { status: 'aborted' };
    }
    throw error;
  } finally {
    shrinkCanvas();
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
  | { kind: 'invalid_mask_area'; target: MaskTarget; mode: 'manual' | 'ratio' }
  | { kind: 'mask_outside_crop'; target: MaskTarget }
  | {
      kind: 'mask_outside_image';
      target: MaskTarget;
      mode: 'manual' | 'ratio';
      width: number;
      height: number;
    }
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

type StaticMaskFailureReason = 'invalid_mask_area' | 'mask_outside_crop' | 'mask_outside_image';

const toStaticMaskAlert = (
  target: MaskTarget,
  reason: StaticMaskFailureReason,
  mode: 'manual' | 'ratio',
  imageSize: ImageDimensions
): PrepareMontagePlanAlert => {
  switch (reason) {
    case 'invalid_mask_area':
      return { kind: 'invalid_mask_area', target, mode };
    case 'mask_outside_crop':
      return { kind: 'mask_outside_crop', target };
    case 'mask_outside_image':
      return {
        kind: 'mask_outside_image',
        target,
        mode,
        width: imageSize.width,
        height: imageSize.height,
      };
  }
};

/**
 * Maps a `PrepareMontagePlanAlert` to the settings accordions that should expand
 * and the fields that should be marked as errors in the UI.
 */
export const resolveMontageAbortUiTarget = (
  alert: PrepareMontagePlanAlert,
  settings: Pick<
    ImageSettings,
    'maskEnabled' | 'maskMode' | 'selfMaskEnabled' | 'selfMaskMode'
  >
): ErrorUiTarget => {
  switch (alert.kind) {
    case 'auto_crop_not_found':
      return { accordions: ['crop'], fields: [] };
    case 'crop_outside_image':
      return { accordions: ['crop'], fields: [...CROP_FIELD_KEYS] };
    case 'invalid_mask_area':
      return {
        accordions: [alert.target],
        fields:
          alert.mode === 'ratio'
            ? [...getMaskRatioFieldKeys(alert.target)]
            : [...getMaskCoordFieldKeys(alert.target)],
      };
    case 'mask_outside_crop':
      return {
        accordions: [alert.target],
        fields: [...getMaskCoordFieldKeys(alert.target)],
      };
    case 'mask_outside_image':
      return {
        accordions: [alert.target],
        fields:
          alert.mode === 'ratio'
            ? [...getMaskRatioFieldKeys(alert.target)]
            : [...getMaskCoordFieldKeys(alert.target)],
      };
    case 'ocr_not_found': {
      const accordions: SettingsAccordionId[] = [];
      if (alert.enemyMissing) accordions.push('mask');
      if (alert.selfMissing) accordions.push('selfMask');
      return { accordions, fields: [] };
    }
    case 'ocr_error': {
      const accordions: SettingsAccordionId[] = [];
      if (settings.maskEnabled && settings.maskMode === 'ocr') accordions.push('mask');
      if (settings.selfMaskEnabled && settings.selfMaskMode === 'ocr') {
        accordions.push('selfMask');
      }
      return { accordions, fields: [] };
    }
    case 'auto_crop_context_error':
    case 'ocr_aborted':
      return { accordions: [], fields: [] };
  }
};

/**
 * Resolves a manual or ratio mask against the crop. A mask that only covers the crop's overhang
 * past the image edges paints nothing but padding, so it fails with `mask_outside_image`.
 */
const resolveStaticMaskRect = (
  enabled: boolean,
  mode: ImageSettings['maskMode'],
  manualRect: PixelRect,
  ratioRect: ImageSettings['maskRatioRect'],
  cropRect: PixelRect,
  imageSize: ImageDimensions
):
  | { ok: true; rect: PixelRect | null; needsRatioPatch: boolean }
  | { ok: false; reason: StaticMaskFailureReason; mode: 'manual' | 'ratio' } => {
  const imageBounds: PixelRect = { x: 0, y: 0, width: imageSize.width, height: imageSize.height };
  const overlapsImage = (rect: PixelRect): boolean =>
    intersectPixelRects(rect, imageBounds) !== null;
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
      return { ok: false, reason: 'invalid_mask_area', mode: 'manual' };
    }
    const clipped = intersectPixelRects(manualRect, cropRect);
    if (!clipped) {
      return { ok: false, reason: 'mask_outside_crop', mode: 'manual' };
    }
    if (!overlapsImage(clipped)) {
      return { ok: false, reason: 'mask_outside_image', mode: 'manual' };
    }
    return { ok: true, rect: clipped, needsRatioPatch: false };
  }
  if (mode === 'ratio') {
    const computed = computeRatioMaskRect(ratioRect, cropRect);
    if (!computed) {
      return { ok: false, reason: 'invalid_mask_area', mode: 'ratio' };
    }
    if (!overlapsImage(computed)) {
      return { ok: false, reason: 'mask_outside_image', mode: 'ratio' };
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
    cropRect,
    imageSize
  );
  if (!enemyStatic.ok) {
    return {
      status: 'abort',
      settingsPatch,
      alert: toStaticMaskAlert('mask', enemyStatic.reason, enemyStatic.mode, imageSize),
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
    cropRect,
    imageSize
  );
  if (!selfStatic.ok) {
    return {
      status: 'abort',
      settingsPatch,
      alert: toStaticMaskAlert('selfMask', selfStatic.reason, selfStatic.mode, imageSize),
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

/**
 * Minimum gap kept between the end of a run that used OCR and the next run.
 * Browsers hand worker (WASM) memory back asynchronously, which mobile tabs can trip over
 * when runs are started back to back.
 */
export const OCR_RERUN_COOLDOWN_MS = 5000;
/** Minimum gap kept between the end of a run that used the montage canvas and the next run. */
export const MONTAGE_RERUN_COOLDOWN_MS = 1000;
/** Short wait at the start of every run so the UI can show progress before heavy work begins. */
export const PROCESS_START_SETTLE_MS = 200;

/**
 * `performance.now()` timestamps of when the last run that used each heavy resource ended
 * (by then the resource has been released), or null.
 */
export interface HeavyResourceReleaseTimes {
  montageReleasedAt: number | null;
  ocrReleasedAt: number | null;
}

export const NO_HEAVY_RESOURCE_RELEASES: HeavyResourceReleaseTimes = {
  montageReleasedAt: null,
  ocrReleasedAt: null,
};

export interface HeavyResourceReleaseUpdate {
  ocrSessionStarted: boolean;
  montageCanvasUsed: boolean;
  reloadTriggered?: boolean;
  /** When the run finished (after its cleanup). */
  now: number;
}

/**
 * Records which heavy resources a finished `processImages` run used, timestamped with the
 * end of the run. Runs that returned before allocating anything heavy keep the previous
 * timestamps, and a run that is reloading the page records nothing.
 */
export const updateHeavyResourceReleaseTimes = (
  previous: HeavyResourceReleaseTimes,
  { ocrSessionStarted, montageCanvasUsed, reloadTriggered = false, now }: HeavyResourceReleaseUpdate
): HeavyResourceReleaseTimes => {
  if (reloadTriggered) {
    return previous;
  }
  return {
    montageReleasedAt: montageCanvasUsed ? now : previous.montageReleasedAt,
    ocrReleasedAt: ocrSessionStarted ? now : previous.ocrReleasedAt,
  };
};

/**
 * Returns how much of the re-run cooldown is still left, i.e. how long a new run must wait
 * so that it starts at least the cooldown after the previous run ended.
 * Returns 0 once every cooldown has elapsed, so a normal single run never waits for it.
 */
export const getRerunCooldownRemainingMs = (
  releaseTimes: HeavyResourceReleaseTimes,
  now: number
): number => {
  const remaining = (releasedAt: number | null, cooldownMs: number): number => {
    if (releasedAt === null) return 0;
    return Math.min(cooldownMs, Math.max(0, releasedAt + cooldownMs - now));
  };
  return Math.max(
    remaining(releaseTimes.montageReleasedAt, MONTAGE_RERUN_COOLDOWN_MS),
    remaining(releaseTimes.ocrReleasedAt, OCR_RERUN_COOLDOWN_MS)
  );
};

/** Formats a byte count into a human-readable B / KB / MB string. */
export const formatFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  return `${(kb / 1024).toFixed(2)} MB`;
};

const EXTENSION_TO_FORMAT_LABEL: Record<string, string> = {
  webp: 'WebP',
  png: 'PNG',
  jpg: 'JPEG',
  jpeg: 'JPEG',
};

/** Maps an output file extension to a display format label. */
export const formatOutputFormatLabel = (extension: string): string => {
  const normalized = extension.trim().toLowerCase();
  return EXTENSION_TO_FORMAT_LABEL[normalized] ?? normalized.toUpperCase();
};

export interface ResultScrollDecisionParams {
  isCompactViewport: boolean;
  resultTop: number;
  viewportHeight: number;
}

/**
 * Determines whether the page should scroll to the result section after processing completes.
 * Avoids scrolling on desktop layouts or when the result section starts comfortably inside the
 * upper viewport on mobile/compact screens.
 */
export const shouldScrollToResult = ({
  isCompactViewport,
  resultTop,
  viewportHeight,
}: ResultScrollDecisionParams): boolean => {
  if (!isCompactViewport || !Number.isFinite(resultTop) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return false;
  }
  return resultTop < 0 || resultTop > viewportHeight * 0.65;
};

export type ActionButtonVariant = 'contained' | 'outlined';

export interface ActionButtonVariants {
  upload: ActionButtonVariant;
  process: ActionButtonVariant;
  download: ActionButtonVariant;
}

/**
 * Resolves MUI button variants across the upload, process, and download steps so only the
 * current primary next action uses `'contained'` while other available actions stay `'outlined'`.
 */
export const resolveActionButtonVariants = (params: {
  hasImages: boolean;
  hasFreshResult: boolean;
}): ActionButtonVariants => ({
  upload: params.hasImages ? 'outlined' : 'contained',
  process: params.hasImages && !params.hasFreshResult ? 'contained' : 'outlined',
  download: params.hasFreshResult ? 'contained' : 'outlined',
});

export interface FileTypeLike {
  name: string;
  type?: string;
}

const SUPPORTED_INPUT_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg']);
const SUPPORTED_INPUT_EXT_RE = /\.(png|jpe?g)$/i;

/** Returns whether a picked or dropped file is a supported PNG/JPEG input image. */
export const isSupportedInputImageFile = (file: FileTypeLike): boolean => {
  const mime = (file.type ?? '').trim().toLowerCase();
  if (mime !== '') {
    return SUPPORTED_INPUT_MIME_TYPES.has(mime);
  }
  return SUPPORTED_INPUT_EXT_RE.test(file.name);
};

export interface FileIdentityLike {
  name: string;
  size: number;
  lastModified: number;
}

export interface MergeImageFilesResult<F> {
  files: F[];
  addedCount: number;
  skippedDuplicateCount: number;
}

/** Appends incoming files to `existing` while deduplicating by name, size, and lastModified. */
export const mergeImageFiles = <F extends FileIdentityLike>(
  existing: readonly F[],
  incoming: readonly F[]
): MergeImageFilesResult<F> => {
  const toKey = (file: FileIdentityLike) => `${file.name}\0${file.size}\0${file.lastModified}`;
  const seen = new Set(existing.map(toKey));
  const appended: F[] = [];
  let skippedDuplicateCount = 0;

  for (const file of incoming) {
    const key = toKey(file);
    if (seen.has(key)) {
      skippedDuplicateCount += 1;
      continue;
    }
    seen.add(key);
    appended.push(file);
  }

  return {
    files: appended.length > 0 ? [...existing, ...appended] : [...existing],
    addedCount: appended.length,
    skippedDuplicateCount,
  };
};

export interface MergeInputImagesResult<F> {
  files: F[];
  addedCount: number;
  unsupportedCount: number;
  duplicateCount: number;
}

/**
 * Filters `incoming` to supported PNG/JPEG images and appends non-duplicate files to
 * `existing`, returning added, unsupported, and duplicate counts.
 */
export const mergeInputImageFiles = <F extends FileTypeLike & FileIdentityLike>(
  existing: readonly F[],
  incoming: readonly F[]
): MergeInputImagesResult<F> => {
  const supported = incoming.filter(isSupportedInputImageFile);
  const unsupportedCount = incoming.length - supported.length;
  const merged = mergeImageFiles(existing, supported);
  return {
    files: merged.files,
    addedCount: merged.addedCount,
    unsupportedCount,
    duplicateCount: merged.skippedDuplicateCount,
  };
};

export type FileSelectionNoticeSpec =
  | { severity: 'error'; messageKey: 'alert_no_supported_images' }
  | {
      severity: 'warning';
      messageKey: 'notice_skipped_both';
      params: { unsupportedCount: number; duplicateCount: number };
    }
  | {
      severity: 'warning';
      messageKey: 'notice_skipped_unsupported';
      params: { count: number };
    }
  | {
      severity: 'info';
      messageKey: 'notice_skipped_duplicate';
      params: { count: number };
    };

/**
 * Classifies the outcome of an image-selection/drop batch into a single notice payload
 * (error when every incoming file is unsupported, or skip summary warning/info).
 */
export const resolveFileSelectionNotice = (
  merged: Pick<MergeInputImagesResult<unknown>, 'addedCount' | 'unsupportedCount' | 'duplicateCount'>
): FileSelectionNoticeSpec | null => {
  if (merged.addedCount === 0 && merged.duplicateCount === 0 && merged.unsupportedCount > 0) {
    return {
      severity: 'error',
      messageKey: 'alert_no_supported_images',
    };
  }
  if (merged.unsupportedCount > 0 && merged.duplicateCount > 0) {
    return {
      severity: 'warning',
      messageKey: 'notice_skipped_both',
      params: {
        unsupportedCount: merged.unsupportedCount,
        duplicateCount: merged.duplicateCount,
      },
    };
  }
  if (merged.unsupportedCount > 0) {
    return {
      severity: 'warning',
      messageKey: 'notice_skipped_unsupported',
      params: { count: merged.unsupportedCount },
    };
  }
  if (merged.duplicateCount > 0) {
    return {
      severity: 'info',
      messageKey: 'notice_skipped_duplicate',
      params: { count: merged.duplicateCount },
    };
  }
  return null;
};

/**
 * Splits long filenames into an ellipsized `head` and a fixed `tail` (preserving extension
 * and trailing identifiers) so narrow mobile rows keep the distinguishing suffix visible.
 */
export const splitFilenameForMiddleEllipsis = (
  filename: string
): { head: string; tail: string } => {
  const chars = Array.from(filename);
  if (chars.length <= 14) {
    return { head: '', tail: filename };
  }
  const tailCount = Math.min(12, Math.floor(chars.length / 2));
  const splitAt = chars.length - tailCount;
  return {
    head: chars.slice(0, splitAt).join(''),
    tail: chars.slice(splitAt).join(''),
  };
};

/** Returns the adjacent item (`step`: -1 or +1) without wrapping around ends. */
export const resolveAdjacentPreviewFile = <F>(
  orderedFiles: readonly F[],
  currentFile: F,
  step: -1 | 1
): F | null => {
  const index = orderedFiles.indexOf(currentFile);
  if (index === -1) {
    return null;
  }
  const nextIndex = index + step;
  if (nextIndex < 0 || nextIndex >= orderedFiles.length) {
    return null;
  }
  return orderedFiles[nextIndex];
};

/**
 * Selects the replacement file to display in the preview dialog after removing `removedFile`:
 * prefers the next item at the same index, falling back to the previous item when deleting
 * the last item, or `null` when no files remain.
 */
export const resolveNextPreviewAfterRemoval = <F>(
  orderedFiles: readonly F[],
  removedFile: F
): F | null => {
  const index = orderedFiles.indexOf(removedFile);
  if (index === -1) {
    return null;
  }
  const remaining = orderedFiles.filter((file) => file !== removedFile);
  if (remaining.length === 0) {
    return null;
  }
  return remaining[Math.min(index, remaining.length - 1)];
};

/**
 * Resolves the target file eligible for removal from the preview dialog, or `null` while
 * a preview transition is in flight or the displayed file is no longer in `orderedFiles`.
 */
export const resolveRemovablePreviewTarget = <F>({
  orderedFiles,
  renderedFile,
  requestedFile,
}: {
  orderedFiles: readonly F[];
  renderedFile: F | null;
  requestedFile: F | null;
}): F | null => {
  if (requestedFile !== null && renderedFile !== requestedFile) {
    return null;
  }
  const targetFile = renderedFile ?? requestedFile;
  if (!targetFile || !orderedFiles.includes(targetFile)) {
    return null;
  }
  return targetFile;
};

export interface NavigatorShareLike {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data?: ShareData) => boolean;
}

/** Returns whether the browser supports sharing `file` via the Web Share API. */
export const canShareImageFile = (
  file: File | null | undefined,
  nav: NavigatorShareLike | undefined = typeof navigator !== 'undefined' ? navigator : undefined
): boolean => {
  if (!file || !nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') {
    return false;
  }
  try {
    return nav.canShare({ files: [file] });
  } catch {
    return false;
  }
};

export interface DragDataTransferLike {
  types?: readonly string[] | DOMStringList | null;
  dropEffect: DataTransfer['dropEffect'];
}

export interface GuardableDragEventLike {
  defaultPrevented: boolean;
  preventDefault: () => void;
  dataTransfer?: DragDataTransferLike | null;
}

/** Returns whether a drag DataTransfer carries external files (`'Files'` in `types`). */
export const hasExternalFilesDataTransfer = (
  dataTransfer: Pick<DragDataTransferLike, 'types'> | null | undefined
): boolean => Array.from(dataTransfer?.types ?? []).includes('Files');

/**
 * Prevents default browser file-open navigation when an external file drag/drop reaches `window`
 * unhandled (`defaultPrevented === false`), and sets `dropEffect = 'none'` on `dragover`.
 */
export const guardWindowFileDragEvent = (
  event: GuardableDragEventLike,
  type: 'dragover' | 'drop'
): boolean => {
  if (event.defaultPrevented || !hasExternalFilesDataTransfer(event.dataTransfer)) {
    return false;
  }
  event.preventDefault();
  if (type === 'dragover' && event.dataTransfer) {
    event.dataTransfer.dropEffect = 'none';
  }
  return true;
};

export const MAX_RATIO_PREVIEW_SIDE = 720;

export interface PreviewCropPlanParams {
  sourceSize: ImageDimensions;
  cropAuto: boolean;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  detectAutoCrop: () => AutoCropResult;
}

export interface PreviewCropPlanResult {
  cropRect: PixelRect;
  autoCropFallback: boolean;
}

/**
 * Resolves the crop rectangle used for ratio-mask previewing on the first image, falling
 * back cleanly to the full image bounds if auto-crop detection fails or manual bounds do
 * not overlap the source image.
 */
export const resolveRatioPreviewCropRect = ({
  sourceSize,
  cropAuto,
  cropX,
  cropY,
  cropWidth,
  cropHeight,
  detectAutoCrop,
}: PreviewCropPlanParams): PreviewCropPlanResult => {
  const fullRect: PixelRect = {
    x: 0,
    y: 0,
    width: Math.max(1, Math.round(sourceSize.width)),
    height: Math.max(1, Math.round(sourceSize.height)),
  };
  if (cropAuto) {
    const autoResult = detectAutoCrop();
    if (autoResult.status === 'ok') {
      return { cropRect: autoResult.rect, autoCropFallback: false };
    }
    return { cropRect: fullRect, autoCropFallback: true };
  }
  const manualRect: PixelRect = { x: cropX, y: cropY, width: cropWidth, height: cropHeight };
  if (
    Number.isSafeInteger(cropX) &&
    Number.isSafeInteger(cropY) &&
    Number.isSafeInteger(cropWidth) &&
    Number.isSafeInteger(cropHeight) &&
    cropX >= 0 &&
    cropY >= 0 &&
    cropWidth > 0 &&
    cropHeight > 0 &&
    hasCropOverlapWithImage(manualRect, fullRect)
  ) {
    return { cropRect: manualRect, autoCropFallback: false };
  }
  return { cropRect: fullRect, autoCropFallback: false };
};

/** Computes scaled preview canvas dimensions capped to `maxSide` while preserving aspect ratio. */
export const computeScaledPreviewDimensions = (
  cropWidth: number,
  cropHeight: number,
  maxSide = MAX_RATIO_PREVIEW_SIDE
): ImageDimensions => {
  const safeW = Math.max(1, cropWidth);
  const safeH = Math.max(1, cropHeight);
  const scale = Math.min(1, maxSide / Math.max(safeW, safeH));
  return {
    width: Math.max(1, Math.round(safeW * scale)),
    height: Math.max(1, Math.round(safeH * scale)),
  };
};

export interface RatioPreviewSnapshot<TFile = unknown> {
  status: 'ok' | 'error';
  url: string;
  autoCropFallback: boolean;
  sourceFile: TFile;
  cropKey: string;
}

export interface MaskAccordionPreviewState {
  hasImages: boolean;
  status: 'loading' | 'ok' | 'error';
  url?: string;
  autoCropFallback?: boolean;
  isUpdating?: boolean;
}

/**
 * Derives the mask-accordion ratio preview state, retaining the previous valid preview
 * image while a replacement builds so the accordion height does not jump mid-edit.
 */
/** Wait before rebuilding the open ratio preview after only the manual crop changed. */
export const RATIO_PREVIEW_CROP_DEBOUNCE_MS = 200;

export interface RatioPreviewRequest<TFile = unknown> {
  file: TFile;
  cropKey: string;
}

/**
 * Returns how long to wait before building the ratio preview. When only the crop changed on the
 * image the open preview already asked for (typing in the crop fields commits every keystroke),
 * wait RATIO_PREVIEW_CROP_DEBOUNCE_MS so each keystroke does not start its own full-size decode.
 * Opening the preview (`previousRequest` is null) or switching images builds right away.
 */
export const resolveRatioPreviewBuildDelayMs = <TFile>(
  previousRequest: RatioPreviewRequest<TFile> | null,
  nextRequest: RatioPreviewRequest<TFile>
): number =>
  previousRequest !== null &&
  previousRequest.file === nextRequest.file &&
  previousRequest.cropKey !== nextRequest.cropKey
    ? RATIO_PREVIEW_CROP_DEBOUNCE_MS
    : 0;

export const resolveMaskAccordionPreviewState = <TFile>({
  hasImages,
  previewSourceImage,
  activeCropKey,
  cachedPreview,
}: {
  hasImages: boolean;
  previewSourceImage: TFile | null;
  activeCropKey: string;
  cachedPreview: RatioPreviewSnapshot<TFile> | null;
}): MaskAccordionPreviewState => {
  if (!hasImages || !previewSourceImage) {
    return { hasImages: false, status: 'loading' };
  }

  const isExactMatch =
    cachedPreview !== null &&
    cachedPreview.sourceFile === previewSourceImage &&
    cachedPreview.cropKey === activeCropKey;

  if (isExactMatch) {
    if (cachedPreview.status === 'error') {
      return { hasImages: true, status: 'error' };
    }
    if (cachedPreview.url) {
      return {
        hasImages: true,
        status: 'ok',
        url: cachedPreview.url,
        autoCropFallback: cachedPreview.autoCropFallback,
        isUpdating: false,
      };
    }
    return { hasImages: true, status: 'loading' };
  }

  if (cachedPreview?.status === 'ok' && cachedPreview.url) {
    return {
      hasImages: true,
      status: 'ok',
      url: cachedPreview.url,
      autoCropFallback: cachedPreview.autoCropFallback,
      isUpdating: true,
    };
  }

  return { hasImages: true, status: 'loading' };
};
