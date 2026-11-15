import type { PixelRect } from './ocrHelpers.ts';

export interface ScanlineContextLike<S> {
  drawImage: (
    image: S,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number
  ) => void;
  getImageData: (sx: number, sy: number, sw: number, sh: number) => { data: ArrayLike<number> };
}

export interface ScanlineCanvasLike<S> {
  width: number;
  height: number;
  getContext: (
    contextId: '2d',
    options?: CanvasRenderingContext2DSettings
  ) => ScanlineContextLike<S> | null;
}

export type AutoCropResult =
  | { status: 'ok'; rect: PixelRect }
  | { status: 'context_error' }
  | { status: 'not_found' };

const getLuminance = (data: ArrayLike<number>, byteOffset: number): number =>
  0.299 * data[byteOffset] + 0.587 * data[byteOffset + 1] + 0.114 * data[byteOffset + 2];

const isPlausibleCropRect = (rect: PixelRect, width: number, height: number): boolean => {
  if (rect.width < width * 0.65) return false;
  if (rect.height < height * 0.5) return false;
  if (rect.y + rect.height > height * 0.95 + 2) return false;
  const aspect = rect.width / rect.height;
  return aspect >= 1.05 && aspect <= 2.7;
};

/**
 * Detects content bounds from center horizontal (`width x 1`) and vertical (`1 x height`)
 * RGBA scanlines, clamping search bounds safely even on tiny image dimensions (`height <= 20`).
 */
export const detectAutoCropRectFromScanlines = (
  hData: ArrayLike<number>,
  vData: ArrayLike<number>,
  width: number,
  height: number
): PixelRect | null => {
  if (width < 3 || height < 3 || hData.length < width * 4 || vData.length < height * 4) {
    return null;
  }

  const findHEdge = (isRight: boolean, threshold: number): number | null => {
    const ASPECT_LIMIT = 2.1;
    const skipX = width / height > ASPECT_LIMIT ? Math.floor((width - height * ASPECT_LIMIT) / 2) + 1 : 0;
    const startX = isRight ? Math.min(width - 2, width - skipX - 2) : skipX + 1;
    for (let x = startX; isRight ? x > 0 : x < width; isRight ? x-- : x++) {
      const lumCurr = getLuminance(hData, x * 4);
      const lumNext = getLuminance(hData, (x + (isRight ? 1 : -1)) * 4);
      if (Math.abs(lumCurr - lumNext) > threshold) {
        return x;
      }
    }
    return null;
  };

  const findVEdge = (isBottom: boolean, threshold: number): number | null => {
    const startY = isBottom ? Math.min(height - 2, Math.floor(height * 0.95)) : 1;
    for (let y = startY; isBottom ? y > 0 : y < height; isBottom ? y-- : y++) {
      const lumCurr = getLuminance(vData, y * 4);
      const lumNext = getLuminance(vData, (y + (isBottom ? 1 : -1)) * 4);
      if (Math.abs(lumCurr - lumNext) > threshold) {
        return y;
      }
    }
    return null;
  };

  const thresholds = [100, 80, 60, 40];
  for (const threshold of thresholds) {
    const left = findHEdge(false, threshold);
    const right = findHEdge(true, threshold);
    const top = findVEdge(false, threshold);
    const bottom = findVEdge(true, threshold);

    if (left !== null && right !== null && top !== null && bottom !== null) {
      const rect: PixelRect = {
        x: left,
        y: top,
        width: right - left + 1,
        height: bottom - top + 1,
      };
      if (isPlausibleCropRect(rect, width, height)) {
        return rect;
      }
    }
  }

  return null;
};

/** Draws a strip of `source` onto a temporary canvas and releases its backing buffer in `finally`. */
export const sampleImageScanline = <S>(
  source: S,
  sx: number,
  sy: number,
  width: number,
  height: number,
  createCanvas: () => ScanlineCanvasLike<S>
): ArrayLike<number> | null => {
  if (width <= 0 || height <= 0) {
    return null;
  }

  const canvas = createCanvas();
  canvas.width = width;
  canvas.height = height;
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    if (!ctx) {
      return null;
    }
    ctx.drawImage(source, sx, sy, width, height, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height).data;
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
};

/** Detects the auto-crop rectangle from an image bitmap, reporting context errors separately from undetected bounds. */
export const detectAutoCropFromImage = <S extends { readonly width: number; readonly height: number }>(
  source: S,
  createCanvas: () => ScanlineCanvasLike<S> = () => document.createElement('canvas') as ScanlineCanvasLike<S>
): AutoCropResult => {
  const width = source.width;
  const height = source.height;
  if (width < 3 || height < 3) {
    return { status: 'not_found' };
  }

  const yMid = Math.floor(height / 2);
  const hData = sampleImageScanline(source, 0, yMid, width, 1, createCanvas);
  if (!hData) {
    return { status: 'context_error' };
  }

  const xMid = Math.floor(width / 2);
  const vData = sampleImageScanline(source, xMid, 0, 1, height, createCanvas);
  if (!vData) {
    return { status: 'context_error' };
  }

  const rect = detectAutoCropRectFromScanlines(hData, vData, width, height);
  return rect ? { status: 'ok', rect } : { status: 'not_found' };
};
